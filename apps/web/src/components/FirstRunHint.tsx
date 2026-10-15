'use client';

/**
 * FirstRunHint.tsx — 웹 공용 컴포넌트.
 *
 * 제공: FirstRunHint.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';

/**
 * 첫 사용 안내(UX 기획 §2-7) — 역할별 랜딩 직후 1회만 뜨는 가벼운 배너.
 *
 * 과한 투어는 넣지 않는다: 임상 사용자는 튜토리얼을 건너뛴다. 정말 몰라서 막히는 3가지만
 * 알린다 — ①내 작업이 어디 있는가 ②모르는 용어를 어떻게 보는가 ③빠른 이동(⌘K).
 * 닫으면 localStorage로 다시 뜨지 않는다.
 */
const KEY = 'lis_firstrun_dismissed_v1';

export default function FirstRunHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(localStorage.getItem(KEY) !== '1');
  }, []);

  if (!show) return null;

  return (
    <div role="note" className="card m-pop mb-4 border-teal/40 no-print">
      <div className="flex items-start justify-between gap-3">
        <div className="t-body">
          <p className="font-semibold mb-1">처음이신가요? 세 가지만 알아두시면 됩니다.</p>
          <ul className="t-meta flex flex-col gap-0.5">
            <li>· <b>내 작업</b> — 이 화면 위쪽 칩이 지금 처리할 목록입니다(역할에 맞춰 표시).</li>
            <li>· <b>점선 밑줄</b> — 모르는 값·용어는 눌러보세요. 뜻·구성·단위가 바로 뜹니다. <Link href="/help/glossary" className="text-teal underline">용어집</Link></li>
            <li>· <b>⌘K</b>(Windows: Ctrl+K) — 화면 이동·검체 조회·용어 검색을 한 번에.</li>
          </ul>
        </div>
        <button
          onClick={() => { localStorage.setItem(KEY, '1'); setShow(false); }}
          className="t-micro border border-line r-ctl px-2 py-1 m-hover hover:border-teal hover:text-teal shrink-0"
        >
          알겠습니다
        </button>
      </div>
    </div>
  );
}
