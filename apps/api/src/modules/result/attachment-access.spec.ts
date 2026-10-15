/**
 * 첨부 도메인 판정 — 단위 테스트 6건.
 *
 * 묶음: 첨부 도메인별 접근 격리.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { attachmentDomain, canAccessAttachment, ATTACH_ANY_READ_ROLES } from './attachment-access';
import { LisRole } from '../../common/rbac/roles';

/**
 * 첨부 다운로드·삭제는 attachmentId만 받는 공용 엔드포인트라 가드로는 도메인을 알 수 없다.
 * 아래 격리가 깨지면 미생물 담당자가 유전체 수탁 결과지를, 검사자가 수혈 이상반응 조사서를
 * 내려받게 된다(회귀 금지).
 */
describe('첨부 도메인 판정', () => {
  it('유전체·수혈·EQA·병리·검체 순으로 소유 도메인 판정', () => {
    expect(attachmentDomain({ genomicOrderId: 'G-1' })).toBe('GENOMIC');
    expect(attachmentDomain({ reactionId: 'R-1' })).toBe('REACTION');
    expect(attachmentDomain({ eqaId: 'E-1' })).toBe('EQA');
    expect(attachmentDomain({ spNo: 'SP-1' })).toBe('PATHOLOGY');
    expect(attachmentDomain({ specimenNo: 'S-1' })).toBe('SPECIMEN');
  });
});

describe('첨부 도메인별 접근 격리', () => {
  it('유전체 첨부: GEN/GC/PHY/ADM/AUD만 조회 가능', () => {
    expect(canAccessAttachment('GENOMIC', [LisRole.GEN], 'READ')).toBe(true);
    expect(canAccessAttachment('GENOMIC', [LisRole.GC], 'READ')).toBe(true);
    // 미생물·검사자·병리는 유전정보 접근 대상이 아니다(08 §3.3 최소권한)
    expect(canAccessAttachment('GENOMIC', [LisRole.MIC], 'READ')).toBe(false);
    expect(canAccessAttachment('GENOMIC', [LisRole.TEC], 'READ')).toBe(false);
    expect(canAccessAttachment('GENOMIC', [LisRole.PAT], 'READ')).toBe(false);
  });

  it('수혈 이상반응 첨부: BB/PHY/ADM/AUD만 조회 가능', () => {
    expect(canAccessAttachment('REACTION', [LisRole.BB], 'READ')).toBe(true);
    expect(canAccessAttachment('REACTION', [LisRole.TEC], 'READ')).toBe(false);
    expect(canAccessAttachment('REACTION', [LisRole.MIC], 'READ')).toBe(false);
  });

  it('감사자(AUD)는 전 도메인 조회 가능하나 삭제는 불가(읽기 전용)', () => {
    for (const d of ['SPECIMEN', 'PATHOLOGY', 'GENOMIC', 'REACTION', 'EQA'] as const) {
      expect(canAccessAttachment(d, [LisRole.AUD], 'READ')).toBe(true);
      expect(canAccessAttachment(d, [LisRole.AUD], 'WRITE')).toBe(false);
    }
  });

  it('검사자(TEC)는 유전체·수혈 첨부를 삭제할 수 없다(증거 인멸 차단)', () => {
    expect(canAccessAttachment('GENOMIC', [LisRole.TEC], 'WRITE')).toBe(false);
    expect(canAccessAttachment('REACTION', [LisRole.TEC], 'WRITE')).toBe(false);
    expect(canAccessAttachment('SPECIMEN', [LisRole.TEC], 'WRITE')).toBe(true);
  });

  it('1차 가드 역할집합은 도메인별 집합의 합집합(GEN이 자기 첨부를 못 받는 일 방지)', () => {
    expect(ATTACH_ANY_READ_ROLES).toContain(LisRole.GEN);
    expect(ATTACH_ANY_READ_ROLES).toContain(LisRole.BB);
    expect(ATTACH_ANY_READ_ROLES).toContain(LisRole.TEC);
  });
});
