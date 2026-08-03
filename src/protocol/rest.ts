/**
 * Module queries over the grpc-gateway REST endpoints (port 1317) — the
 * ruled chain-access transport for queries (build plan §1.3). React Native
 * is not a browser: plain `fetch`, no CORS surface, no gRPC-web plumbing.
 *
 * Responses are decoded through the vendored ts-proto `fromJSON` codecs.
 * The gateway emits proto field names (snake_case); ts-proto's fromJSON
 * expects the proto3 JSON names (camelCase) — `camelise` normalises deeply
 * and tolerates either casing, so a gateway configuration change cannot
 * silently break decoding.
 */

import { toBase64 } from '@cosmjs/encoding';

import {
  QueryGuardianResponse,
  QueryHintsSinceResponse,
  QuerySecretAssignmentsResponse,
  QuerySecretPayloadResponse,
  QuerySecretMetaResponse,
  QuerySecretRevealsResponse,
  QuerySecretsByCreatorResponse,
  QuerySecretTombstoneResponse,
  SecretAssignmentView,
  SecretView,
  HintRecord,
} from '../generated/timeflare/secrets/v1/query';
import { RevealedShare, Secret, SecretTombstone } from '../generated/timeflare/secrets/v1/secret';
import { Guardian } from '../generated/timeflare/secrets/v1/guardian';

export class RestError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly grpcCode?: number,
    private readonly transport: boolean = false,
  ) {
    super(message);
    this.name = 'RestError';
  }

  /**
   * True when the request never produced an HTTP response at all — the fetch
   * rejected (dead endpoint, refused connection) or the deadline fired. A
   * node-side error (500, 404) is NOT transport: the endpoint is reachable
   * and answered. Callers branch on this rather than string-matching the
   * message, so an "offline" banner never fires for a node that is up but
   * unhappy.
   */
  get isTransport(): boolean {
    return this.transport;
  }

  /**
   * A failure that never reached the endpoint. Named rather than assembled
   * positionally because the flag is the whole point of the error — callers
   * retry on it — and `new RestError(msg, undefined, undefined, true)` buries
   * that behind two placeholders.
   */
  static transportFailure(message: string): RestError {
    return new RestError(message, undefined, undefined, true);
  }
}

/** Deeply convert snake_case object keys to camelCase (arrays preserved). */
export function camelise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelise);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const camel = key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      out[camel] = camelise(v);
    }
    return out;
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  if (error instanceof RestError) {
    return error.httpStatus === 404 || error.grpcCode === 5 ||
      error.message.toLowerCase().includes('not found');
  }
  return false;
}

/**
 * Per-request deadline: long enough for a slow public node, short enough that
 * a black-holed connection (NAT timeout, captive portal) surfaces as an error
 * instead of hanging a caller that awaits every query in sequence.
 */
export const DEFAULT_REST_TIMEOUT_MS = 10_000;

/** Height + consensus time out of a header, whichever transport carried it. */
function readHeader(header: { height?: string; time?: string } | undefined): {
  height: number;
  timeMs: number;
} {
  const height = Number(header?.height ?? NaN);
  if (!Number.isFinite(height)) {
    throw new RestError('could not read the block height');
  }
  const timeMs = Date.parse(header?.time ?? '');
  if (!Number.isFinite(timeMs)) {
    throw new RestError(`block ${height} carried no readable consensus time`);
  }
  return { height, timeMs };
}

export class TimeflareRestClient {
  private readonly timeoutMs: number;
  private readonly rpcUrl?: string;
  /**
   * Set once a CometBFT RPC read fails in a way that says the endpoint is not
   * there at all (404, connection refused, a body that is not JSON-RPC). One
   * such answer is enough: retrying it on every header read would double the
   * request count for the whole session to re-learn the same thing.
   */
  private rpcUnavailable = false;

  constructor(
    private readonly baseUrl: string,
    opts?: { timeoutMs?: number; rpcUrl?: string },
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS;
    this.rpcUrl = opts?.rpcUrl?.replace(/\/+$/, '');
  }

  private async get(path: string): Promise<unknown> {
    // The deadline covers the whole request — headers AND body. A server that
    // answers headers then stalls the body is the same wedge as one that
    // never answers at all.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      // Only this client aborts its own signal, so an abort here is the
      // deadline firing — name it as such rather than as a generic failure.
      if (controller.signal.aborted) {
        throw RestError.transportFailure(
          `GET ${path} timed out after ${this.timeoutMs}ms against ${this.baseUrl}`,
        );
      }
      throw RestError.transportFailure(
        `REST endpoint unreachable at ${this.baseUrl}: ${error}`,
      );
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const grpc = body as { code?: number; message?: string } | undefined;
      throw new RestError(
        `GET ${path} failed (HTTP ${response.status}): ${grpc?.message ?? text}`,
        response.status,
        grpc?.code,
      );
    }
    return camelise(body);
  }

  /**
   * A block header's height and its CONSENSUS time, via the standard
   * tendermint query service. Omit `height` for the latest block.
   *
   * Consensus time, not the device clock, is what makes a measured block
   * interval trustworthy: it is the chain's own account of when the block
   * closed, so an interval derived from two headers carries no local skew.
   * `BlockClock` is built on this.
   *
   * A pruned node answers only for heights it still holds; the caller decides
   * what to do about that (BlockClock shortens its baseline).
   */
  async blockHeader(height?: number): Promise<{ height: number; timeMs: number }> {
    const viaRpc = await this.headerViaRpc(height);
    if (viaRpc !== undefined) return viaRpc;

    const at = height === undefined ? 'latest' : String(height);
    const body = (await this.get(`/cosmos/base/tendermint/v1beta1/blocks/${at}`)) as {
      block?: { header?: { height?: string; time?: string } };
    };
    return readHeader(body?.block?.header);
  }

  /**
   * The same header from CometBFT's RPC, which returns the header ALONE.
   *
   * The REST route returns the whole block — every transaction in it — to
   * deliver two fields. Measured against Cosmos Hub: 89 KB per block against
   * 1.1 KB per header, an ~80× difference on a query the app makes on every
   * status probe, inbox probe and seal anchor, plus three times over on a
   * cold-start measurement.
   *
   * Returns undefined when the RPC cannot serve us AT ALL, so the caller falls
   * back to REST — not every deployment exposes 26657, and reads must not
   * start depending on it. A pruned height is a different thing entirely: that
   * is the node authoritatively answering, so it throws and lets BlockClock's
   * anchor ladder step down to a shorter baseline instead of paying for a
   * second, equally doomed REST request.
   */
  private async headerViaRpc(
    height?: number,
  ): Promise<{ height: number; timeMs: number } | undefined> {
    if (this.rpcUrl === undefined || this.rpcUnavailable) return undefined;
    const query = height === undefined ? '' : `?height=${height}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let text: string;
    try {
      const response = await fetch(`${this.rpcUrl}/header${query}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      text = await response.text();
    } catch {
      this.rpcUnavailable = true;
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    let body: {
      jsonrpc?: string;
      result?: { header?: unknown };
      error?: unknown;
    };
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON-RPC — a proxy error page, or something that is not a node.
      this.rpcUnavailable = true;
      return undefined;
    }
    // Only a well-formed JSON-RPC error is the NODE talking, and only then
    // does "unavailable" mean the height is pruned. Load balancers in front of
    // public endpoints answer with their own shape — `{"error": "<string>"}`,
    // no `jsonrpc` — and treating that as an answer would report a healthy
    // chain's block as missing and stop the anchor ladder dead.
    const nodeError =
      typeof body.jsonrpc === 'string' && typeof body.error === 'object' && body.error !== null
        ? (body.error as { data?: string; message?: string })
        : undefined;
    if (nodeError) {
      throw new RestError(
        `header ${height ?? 'latest'} unavailable: ${nodeError.data ?? nodeError.message}`,
      );
    }
    if (body.result?.header === undefined) {
      this.rpcUnavailable = true;
      return undefined;
    }
    return readHeader(body.result.header as { height?: string; time?: string });
  }

  /** Current chain height via the standard tendermint query service. */
  async height(): Promise<number> {
    return (await this.blockHeader()).height;
  }

  /** Account spendable balance of one denom, in base units. */
  async balance(address: string, denom = 'uveil'): Promise<bigint> {
    const body = (await this.get(
      `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${denom}`,
    )) as { balance?: { amount?: string } };
    return BigInt(body?.balance?.amount ?? '0');
  }

  /**
   * The slim secret record, or null when the secret does not (or no longer)
   * exists.
   *
   * This is the read every status surface wants. The full view assembles the
   * per-guardian side stores, so it carries every guardian's `encrypted_share`
   * and `share_hmac` bytes — several kilobytes per secret at the 32-guardian
   * ceiling, base64 over JSON, to render a status pill. The slim record holds
   * the timing, the economics, the denormalised counters and the frozen bond
   * amounts, which between them are everything a client needs short of the
   * share material itself. Reconstruction included: it needs the threshold,
   * `pk_s` and the commitment, and takes the shares from `secretReveals`.
   */
  async secretMeta(secretId: string): Promise<Secret | null> {
    try {
      const body = await this.get(`/timeflare/secrets/v1/secret/${secretId}/meta`);
      return QuerySecretMetaResponse.fromJSON(body).secret ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Per-guardian assignment status (no share bytes) — the acceptance watch. */
  async secretAssignments(secretId: string): Promise<SecretAssignmentView[]> {
    const body = await this.get(`/timeflare/secrets/v1/secret/${secretId}/assignments`);
    return QuerySecretAssignmentsResponse.fromJSON(body).assignments;
  }

  /** Revealed key-share envelopes — the reveal watch + reconstruction input. */
  async secretReveals(secretId: string): Promise<RevealedShare[]> {
    const body = await this.get(`/timeflare/secrets/v1/secret/${secretId}/reveals`);
    return QuerySecretRevealsResponse.fromJSON(body).reveals;
  }

  /** The stored payload ciphertext, or null (not yet distributed / pruned). */
  async secretPayload(secretId: string): Promise<Uint8Array | null> {
    try {
      const body = await this.get(`/timeflare/secrets/v1/secret/${secretId}/payload`);
      const payload = QuerySecretPayloadResponse.fromJSON(body).payloadCiphertext;
      return payload.length > 0 ? payload : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * The incremental discovery-scan feed: compact hint records for secrets
   * created at or after sinceHeight, in creation order.
   *
   * Page boundaries are walked with the store's own `pagination.key`, never
   * by rewinding the height cursor: heights are not unique, so a height-based
   * rewind cannot advance past a creation height denser than one page.
   * `nextKey` is undefined once the range is exhausted; pass it back verbatim
   * (with the SAME sinceHeight) to fetch the next page.
   */
  async hintsSince(
    sinceHeight: number,
    limit?: number,
    pageKey?: Uint8Array,
  ): Promise<{ hints: HintRecord[]; nextKey: Uint8Array | undefined }> {
    const params: string[] = [];
    if (limit !== undefined) params.push(`pagination.limit=${limit}`);
    if (pageKey !== undefined && pageKey.length > 0) {
      params.push(`pagination.key=${encodeURIComponent(toBase64(pageKey))}`);
    }
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    const body = await this.get(`/timeflare/secrets/v1/hints/${sinceHeight}${query}`);
    const response = QueryHintsSinceResponse.fromJSON(body);
    const nextKey = response.pagination?.nextKey;
    return {
      hints: response.hints,
      nextKey: nextKey !== undefined && nextKey.length > 0 ? nextKey : undefined,
    };
  }

  /**
   * A creator's secrets (assembled views). Pruned secrets are absent —
   * creator-side history beyond the retention window needs local caching
   * (alignment plan §5.13).
   *
   * Pagination is followed to exhaustion internally rather than exposing the
   * page key: callers treat this as "the creator's secrets", and a keyed
   * signature would push silent truncation onto every one of them. `limit`
   * sizes the pages the walk fetches, not the result.
   */
  async secretsByCreator(creator: string, limit?: number): Promise<SecretView[]> {
    const secrets: SecretView[] = [];
    let pageKey: Uint8Array | undefined;
    for (;;) {
      const params: string[] = [];
      if (limit !== undefined) params.push(`pagination.limit=${limit}`);
      if (pageKey !== undefined && pageKey.length > 0) {
        params.push(`pagination.key=${encodeURIComponent(toBase64(pageKey))}`);
      }
      const query = params.length > 0 ? `?${params.join('&')}` : '';
      const body = await this.get(`/timeflare/secrets/v1/secrets/creator/${creator}${query}`);
      const response = QuerySecretsByCreatorResponse.fromJSON(body);
      secrets.push(...response.secrets);
      const nextKey = response.pagination?.nextKey;
      if (nextKey === undefined || nextKey.length === 0) {
        return secrets;
      }
      pageKey = nextKey;
    }
  }

  /** The permanent tombstone of a pruned secret, or null. */
  async secretTombstone(secretId: string): Promise<SecretTombstone | null> {
    try {
      const body = await this.get(`/timeflare/secrets/v1/secret/${secretId}/tombstone`);
      return QuerySecretTombstoneResponse.fromJSON(body).tombstone ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Guardian record (encryption public key lives here), or null. */
  async guardian(address: string): Promise<Guardian | null> {
    try {
      const body = await this.get(`/timeflare/secrets/v1/guardian/${address}`);
      return QueryGuardianResponse.fromJSON(body).guardian ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}
