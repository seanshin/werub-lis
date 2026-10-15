/**
 * 권한 매트릭스 (RBAC) — 단위 테스트 9건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { can, LisRole, Feature, Access } from './roles';

describe('권한 매트릭스 (RBAC)', () => {
  it('접수담당(RCP)은 접수(W) 가능, 결과입력(W) 불가', () => {
    expect(can([LisRole.RCP], Feature.RCV, Access.W)).toBe(true);
    expect(can([LisRole.RCP], Feature.RES, Access.W)).toBe(false);
  });

  it('검사자(TEC)는 결과입력(W)·1차검증(V) 가능, 2차검증/확정(S) 불가', () => {
    expect(can([LisRole.TEC], Feature.RES, Access.W)).toBe(true);
    expect(can([LisRole.TEC], Feature.RES, Access.R)).toBe(true); // 결과 조회 가능
    expect(can([LisRole.PHY], Feature.RES, Access.R)).toBe(true);
    expect(can([LisRole.TEC], Feature.V1, Access.V)).toBe(true);
    expect(can([LisRole.TEC], Feature.V2, Access.S)).toBe(false);
  });

  it('검증의(PHY)만 2차검증/확정·결과보고 서명(S) 가능 (직무분리)', () => {
    expect(can([LisRole.PHY], Feature.V2, Access.S)).toBe(true);
    expect(can([LisRole.PHY], Feature.RPT, Access.S)).toBe(true);
    expect(can([LisRole.TEC], Feature.RPT, Access.S)).toBe(false);
  });

  it('유전체 결과 조회는 GEN/GC/PHY/ADM만, 접수담당·미생물은 불가 (민감정보 격리)', () => {
    expect(can([LisRole.GEN], Feature.GEN_RES, Access.R)).toBe(true);
    expect(can([LisRole.PHY], Feature.GEN_RES, Access.R)).toBe(true);
    expect(can([LisRole.RCP], Feature.GEN_RES, Access.R)).toBe(false);
    expect(can([LisRole.MIC], Feature.GEN_RES, Access.R)).toBe(false);
  });

  it('마스터 관리(W/A)는 관리자(ADM)만', () => {
    expect(can([LisRole.ADM], Feature.MST, Access.W)).toBe(true);
    expect(can([LisRole.TEC], Feature.MST, Access.W)).toBe(false);
    expect(can([LisRole.TEC], Feature.MST, Access.R)).toBe(true); // 조회는 가능
  });

  it('감사추적은 ADM/AUD만', () => {
    expect(can([LisRole.AUD], Feature.AUD, Access.R)).toBe(true);
    expect(can([LisRole.PHY], Feature.AUD, Access.R)).toBe(false);
  });

  it('복수 역할 보유 시 합집합으로 판정', () => {
    expect(can([LisRole.TEC, LisRole.PHY], Feature.V2, Access.S)).toBe(true);
  });

  it('통계 조회: 병리(PAT)·수혈(BB) 판독/담당 허용(도메인 QA), 유전(GEN)은 제외', () => {
    expect(can([LisRole.PAT], Feature.STAT, Access.R)).toBe(true);
    expect(can([LisRole.BB], Feature.STAT, Access.R)).toBe(true); // 수혈 통계 조회
    expect(can([LisRole.GEN], Feature.STAT, Access.R)).toBe(false);
    expect(can([LisRole.RCP], Feature.STAT, Access.R)).toBe(false);
    // 통계 R 부여가 일반 결과입력(F-RES)까지 새면 안 된다(최소권한)
    expect(can([LisRole.PAT], Feature.RES, Access.W)).toBe(false);
    expect(can([LisRole.BB], Feature.RES, Access.W)).toBe(false);
  });

  it('외부위탁(F-SEND): 판독의(PAT/GEN) R,W 허용 — 단 일반 결과입력(F-RES)은 불가(분리)', () => {
    expect(can([LisRole.PAT], Feature.SEND, Access.W)).toBe(true);
    expect(can([LisRole.GEN], Feature.SEND, Access.W)).toBe(true);
    expect(can([LisRole.PAT], Feature.RES, Access.W)).toBe(false); // 위탁 허용이 결과입력으로 새지 않음
    expect(can([LisRole.GEN], Feature.RES, Access.W)).toBe(false);
    // 기존 보유 역할 계승(회귀 방지): TEC/PHY/MIC 쓰기, ADM/AUD 조회
    expect(can([LisRole.TEC], Feature.SEND, Access.W)).toBe(true);
    expect(can([LisRole.ADM], Feature.SEND, Access.R)).toBe(true);
    expect(can([LisRole.ADM], Feature.SEND, Access.W)).toBe(false); // 기존 F-RES와 동일(ADM 조회만)
    expect(can([LisRole.RCP], Feature.SEND, Access.R)).toBe(false);
  });
});
