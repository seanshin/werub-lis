Pretendard Variable (self-hosted)

파일: PretendardVariable.woff2 (v1.3.9)
출처: https://github.com/orioncactus/pretendard
라이선스: SIL Open Font License 1.1 (OFL-1.1)
  전문: https://github.com/orioncactus/pretendard/blob/main/OFL.txt
  상용 이용·재배포·임베딩 허용. 폰트 자체를 판매하지 않는 한 제약 없음.

★ 왜 CDN이 아니라 자체 호스팅인가
  병원 내부망은 외부 인터넷이 차단된 경우가 많다. CDN 링크를 쓰면 폰트가
  조용히 실패하고 system-ui로 폴백되어, 개발자 화면과 현장 화면의 인상이
  달라진다(그리고 아무도 모른다). 그래서 앱에 함께 배포한다.

★ 교체 시
  woff2 파일만 바꾸고 globals.css의 @font-face src 경로를 맞춘다.
  가변 폰트라 weight 45~920을 한 파일로 처리하므로 굵기별 파일은 필요 없다.
