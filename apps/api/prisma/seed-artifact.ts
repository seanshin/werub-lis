/**
 * 시드 산출물 추적 — 시드가 만든 행을 `seed_artifact`에 등록한다.
 *
 * 왜 프록시인가: 시드 코드는 `createMany`/`create`/`upsert` 호출이 수십 곳이다. 각 호출부에
 * 등록 코드를 붙이면 **빠뜨리는 곳이 생기고**, 빠진 곳은 나중에 "지울 수 없는 시드 데이터"가 된다.
 * 클라이언트를 한 겹 감싸면 호출부를 건드리지 않고 전수 기록된다.
 *
 * PK는 Prisma DMMF에서 모델별로 읽는다(복합키는 값을 '|'로 이어 붙인다).
 * 기록 실패가 시드를 막지 않는다 — 시드는 되지만 정리 대상에서 빠지므로 **경고를 남긴다**.
 *
 * 근거: docs/개시전환센터_기획서.md §3.5
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { Prisma, PrismaClient } from '@prisma/client';

/** 배치 4종 — 자유 문자열 금지(지울 것과 남길 것이 구분되지 않는다). */
export const SEED_BATCHES = ['product-demo', 'site-starter', 'site-pilot', 'e2e'] as const;
export type SeedBatch = (typeof SEED_BATCHES)[number];

/** 델리게이트명(예: 'labOrder') → PK 필드 목록. 복합키면 2개 이상. */
function buildIdFieldMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const delegate = model.name.charAt(0).toLowerCase() + model.name.slice(1);
    if (model.primaryKey?.fields?.length) {
      map.set(delegate, [...model.primaryKey.fields]); // @@id([...]) 복합키
    } else {
      const idField = model.fields.find((f) => f.isId);
      if (idField) map.set(delegate, [idField.name]);
    }
  }
  return map;
}

const ID_FIELDS = buildIdFieldMap();

function pkOf(delegate: string, row: Record<string, unknown>): string | null {
  const fields = ID_FIELDS.get(delegate);
  if (!fields) return null;
  const parts: string[] = [];
  for (const f of fields) {
    const v = row[f];
    if (v === undefined || v === null) return null; // @default(cuid()) 등 — 값을 모르면 기록하지 않는다
    parts.push(String(v));
  }
  return parts.join('|');
}

/** create/createMany/upsert의 인자에서 기록 대상 행들을 뽑는다. */
function rowsFromArgs(op: string, args: unknown): Record<string, unknown>[] {
  const a = args as { data?: unknown; create?: unknown } | undefined;
  if (!a) return [];
  if (op === 'upsert') return a.create ? [a.create as Record<string, unknown>] : [];
  const data = a.data;
  if (!data) return [];
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [data as Record<string, unknown>];
}

/**
 * 시드용 클라이언트 래퍼 — 이 클라이언트로 만든 행은 전부 `batch`로 등록된다.
 * 시드 스크립트는 반환된 객체를 평소처럼 쓰면 된다.
 */
export function withSeedTracking(prisma: PrismaClient, batch: SeedBatch): PrismaClient {
  const pending: { entity: string; pk: string }[] = [];

  const record = (entity: string, rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const pk = pkOf(entity, row);
      if (pk) pending.push({ entity, pk });
    }
  };

  const flush = async () => {
    if (pending.length === 0) return;
    const batchRows = pending.splice(0, pending.length).map((p, i) => ({
      artifactId: `SA-${batch}-${p.entity}-${Buffer.from(p.pk).toString('base64url').slice(0, 24)}-${i}`,
      batch,
      entity: p.entity,
      pk: p.pk,
    }));
    try {
      await prisma.seedArtifact.createMany({ data: batchRows, skipDuplicates: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[seed-artifact] 등록 실패(${batch}) — 이 행들은 선택 삭제 대상에서 빠진다: ${e instanceof Error ? e.message : e}`);
    }
  };

  /**
   * ★이미 존재하던 행은 기록하지 않는다(2026-07-30 적대 검토 CRITICAL).
   *
   * 이전에는 호출 인자를 그대로 기록했다. 그런데 시드는 멱등을 위해
   * `createMany({ skipDuplicates: true })`·`upsert`를 쓰므로 **성공 ≠ 삽입**이다.
   * 실 환자와 같은 식별자(시드 MRN은 7자리 숫자다)가 이미 있으면 행은 삽입되지 않는데
   * 등록만 남아, 그 **실 환자가 '시드'로 분류되어 삭제 대상**이 된다.
   * "실 데이터는 구조적으로 삭제 대상이 되지 않는다"는 불변식이 여기서 깨졌다.
   */
  const existingBefore = async (delegate: string, rows: Record<string, unknown>[]): Promise<Set<string>> => {
    const fields = ID_FIELDS.get(delegate);
    if (!fields || rows.length === 0) return new Set();
    const pks = rows.map((r) => pkOf(delegate, r)).filter((x): x is string => !!x);
    if (pks.length === 0) return new Set();
    try {
      const model = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<Record<string, unknown>[]> }>)[delegate];
      const where = fields.length === 1
        ? { [fields[0]]: { in: pks } }
        : { OR: pks.map((pk) => Object.fromEntries(fields.map((f, i) => [f, pk.split('|')[i]]))) };
      const found = await model.findMany({ where, select: Object.fromEntries(fields.map((f) => [f, true])) });
      return new Set(found.map((r) => fields.map((f) => String(r[f])).join('|')));
    } catch {
      // 조회 실패 시 **전부 기존 행으로 간주**한다(기록하지 않는다) — 잘못 등록하는 쪽이 훨씬 위험하다.
      return new Set(pks);
    }
  };

  const proxy = new Proxy(prisma, {
    get(target, prop: string | symbol) {
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      // 시드가 끝날 때 호출해 남은 기록을 반영한다
      if (prop === '$seedFlush') return flush;
      if (typeof prop !== 'string' || prop.startsWith('$') || typeof value !== 'object' || value === null) {
        return value;
      }
      const delegate = prop;
      if (!ID_FIELDS.has(delegate) || delegate === 'seedArtifact') return value;

      return new Proxy(value as object, {
        get(dTarget, dProp: string | symbol) {
          const fn = (dTarget as unknown as Record<string | symbol, unknown>)[dProp];
          if (typeof fn !== 'function') return fn;
          if (dProp !== 'create' && dProp !== 'createMany' && dProp !== 'upsert') return fn;
          return async (...args: unknown[]) => {
            const rows = rowsFromArgs(dProp as string, args[0]);
            // 호출 **전에** 이미 있던 행을 파악한다 — 그것들은 시드가 만든 것이 아니다.
            const preExisting = await existingBefore(delegate, rows);
            const r = await (fn as (...a: unknown[]) => Promise<unknown>).apply(dTarget, args);
            // 성공했고, 그리고 **새로 생긴 것만** 기록한다.
            record(delegate, rows.filter((row) => {
              const pk = pkOf(delegate, row);
              return pk !== null && !preExisting.has(pk);
            }));
            return r;
          };
        },
      });
    },
  });

  return proxy as PrismaClient;
}

/** 추적 클라이언트의 남은 기록을 반영한다(시드 마지막에 호출). */
export async function flushSeedArtifacts(tracked: PrismaClient): Promise<void> {
  const flush = (tracked as unknown as { $seedFlush?: () => Promise<void> }).$seedFlush;
  if (flush) await flush();
}
