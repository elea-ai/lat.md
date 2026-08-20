import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectProvider,
  type EmbeddingProvider,
} from '../src/search/provider.js';
import { planBatches } from '../src/search/embeddings.js';
import { openDb, ensureSchema, closeDb } from '../src/search/db.js';
import { indexSections } from '../src/search/index.js';
import { searchSections } from '../src/search/search.js';
import { startReplayServer, hasReplayData } from './rag-replay-server.js';
import type { Client } from '@libsql/client';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// --- Unit tests (always run) ---

// @lat: [[search#Provider Detection]]
describe('detectProvider', () => {
  it('detects OpenAI key', () => {
    const p = detectProvider('sk-abc123');
    expect(p.name).toBe('openai');
  });

  it('detects Vercel key', () => {
    const p = detectProvider('vck_abc123');
    expect(p.name).toBe('vercel');
  });

  it('rejects Anthropic key with helpful message', () => {
    expect(() => detectProvider('sk-ant-abc123')).toThrow(/Anthropic/);
  });

  it('rejects unknown key', () => {
    expect(() => detectProvider('xyz_abc123')).toThrow(/Unrecognized/);
  });
});

// @lat: [[cli#search#Embeddings]]
describe('planBatches', () => {
  it('keeps a small corpus in a single batch', () => {
    const batches = planBatches(['a', 'b', 'c']);
    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  it('splits when the estimated token budget is exceeded', () => {
    // ~4 chars/token, 250k-token cap → ~1M chars per batch.
    const big = 'x'.repeat(600_000); // ~150k tokens each
    const batches = planBatches([big, big, big]);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
  });

  it('never emits an empty batch', () => {
    expect(planBatches([])).toEqual([]);
    expect(planBatches(['only']).every((b) => b.length > 0)).toBe(true);
  });

  it('preserves order and loses no inputs', () => {
    const texts = Array.from({ length: 5000 }, (_, i) => `text-${i}`);
    const batches = planBatches(texts);
    expect(batches.length).toBeGreaterThan(1); // > 2048 count cap
    expect(batches.flat()).toEqual(texts);
  });
});

// --- RAG functional tests ---
//
// Two modes:
// - Normal (default): replays cached vectors from tests/cases/rag/replay-data/
// - Capture (_LAT_TEST_CAPTURE_EMBEDDINGS=1): proxies to real API via LAT_LLM_KEY,
//   records vectors to replay-data/, then runs assertions against live results
//
// To re-cook: pnpm cook-test-rag

const capturing = !!process.env._LAT_TEST_CAPTURE_EMBEDDINGS;
const replayDir = join(import.meta.dirname, 'cases', 'rag', 'replay-data');
const canRun = capturing || hasReplayData(replayDir);

describe.skipIf(!canRun)('search (rag)', () => {
  let tmp: string;
  let latDir: string;
  let db: Client;
  let server: Server;
  let provider: EmbeddingProvider;
  let replayKey: string;
  let flushCapture: () => void;

  beforeAll(async () => {
    if (capturing) {
      // Capture mode: proxy to real API, record vectors
      const realKey = process.env.LAT_LLM_KEY;
      if (!realKey) throw new Error('LAT_LLM_KEY must be set in capture mode');
      const realProvider = detectProvider(realKey);

      const replay = await startReplayServer(replayDir, {
        capture: true,
        provider: realProvider,
        key: realKey,
      });
      server = replay.server;
      flushCapture = replay.flush;
      replayKey = `REPLAY_LAT_LLM_KEY::${replay.url}`;
      provider = detectProvider(replayKey);
    } else {
      // Replay mode: serve cached vectors
      const replay = await startReplayServer(replayDir);
      server = replay.server;
      flushCapture = replay.flush;
      replayKey = `REPLAY_LAT_LLM_KEY::${replay.url}`;
      provider = detectProvider(replayKey);
    }

    // Copy fixture to tmp so .cache doesn't pollute the repo
    tmp = mkdtempSync(join(tmpdir(), 'lat-rag-'));
    latDir = join(tmp, 'lat.md');
    cpSync(join(import.meta.dirname, 'cases', 'rag', 'lat.md'), latDir, {
      recursive: true,
    });

    db = openDb(latDir);
    await ensureSchema(db, provider.dimensions);
  });

  afterAll(async () => {
    if (capturing) flushCapture();
    if (db) await closeDb(db);
    if (server) server.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // @lat: [[search#RAG Replay Tests#Indexes all sections]]
  it('indexes all sections', async () => {
    const stats = await indexSections(latDir, db, provider, replayKey);
    expect(stats.added).toBe(9);
    expect(stats.updated).toBe(0);
    expect(stats.removed).toBe(0);
    expect(stats.unchanged).toBe(0);
  });

  // @lat: [[search#RAG Replay Tests#Finds auth section for login query]]
  it('finds auth section for login query', async () => {
    const results = await searchSections(
      db,
      'how do we handle user login and security?',
      provider,
      replayKey,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toContain('Authentication');
  });

  // @lat: [[search#RAG Replay Tests#Finds performance section for latency query]]
  it('finds performance section for latency query', async () => {
    const results = await searchSections(
      db,
      'what tools do we use to measure response times?',
      provider,
      replayKey,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toContain('Performance');
  });

  // @lat: [[search#RAG Replay Tests#Incremental index skips unchanged sections]]
  it('incremental index skips unchanged sections', async () => {
    const stats = await indexSections(latDir, db, provider, replayKey);
    expect(stats.unchanged).toBe(9);
    expect(stats.added).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.removed).toBe(0);
  });

  // @lat: [[search#RAG Replay Tests#Detects deleted sections when file is removed]]
  it('detects deleted sections when file is removed', async () => {
    rmSync(join(latDir, 'testing.md'));

    const stats = await indexSections(latDir, db, provider, replayKey);
    expect(stats.removed).toBe(4); // testing + unit + integration + performance
    expect(stats.unchanged).toBe(5); // architecture sections remain
  });
});

// --- Incremental persistence ---
//
// Uses a stub embeddings endpoint (no replay data needed): the sections are
// sized so planBatches has to split them across separate requests, and the
// stub fails one of those requests on purpose.

describe('indexSections persistence', () => {
  let tmp: string;
  let latDir: string;
  let db: Client;
  let server: Server;
  let provider: EmbeddingProvider;
  let key: string;
  let requests: number;
  let failRequest: number | null;

  // ~150k estimated tokens per section, so each one needs its own request
  // under the 250k-token budget.
  const filler = 'x'.repeat(600_000);

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'lat-persist-'));
    latDir = join(tmp, 'lat.md');
    mkdirSync(latDir, { recursive: true });
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(
        join(latDir, `${name}.md`),
        `# Section ${name}\n\n${filler}\n`,
      );
    }

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        requests++;
        if (requests === failRequest) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'stub failure' } }));
          return;
        }
        const inputs = JSON.parse(body).input as string[];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: inputs.map((_, index) => ({
              index,
              embedding: Array.from({ length: 1536 }, () => 0.1),
            })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    key = `REPLAY_LAT_LLM_KEY::http://127.0.0.1:${port}`;
    provider = detectProvider(key);

    db = openDb(latDir);
    await ensureSchema(db, provider.dimensions);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    if (server) server.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function sectionCount(): Promise<number> {
    const rows = await db.execute('SELECT COUNT(*) as n FROM sections');
    return Number(rows.rows[0].n);
  }

  // @lat: [[search#Index Persistence#Keeps batches written before a failure]]
  it('keeps batches written before a failure', async () => {
    requests = 0;
    failRequest = 2;

    await expect(indexSections(latDir, db, provider, key)).rejects.toThrow(
      /Embedding API error/,
    );

    expect(requests).toBe(2);
    expect(await sectionCount()).toBe(1);
  });

  // @lat: [[search#Index Persistence#Resumes from the sections still missing]]
  it('resumes from the sections still missing', async () => {
    requests = 0;
    failRequest = null;

    const stats = await indexSections(latDir, db, provider, key);

    expect(stats.added).toBe(2);
    expect(stats.unchanged).toBe(1);
    expect(await sectionCount()).toBe(3);
  });
});
