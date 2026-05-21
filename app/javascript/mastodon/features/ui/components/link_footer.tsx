// 폐쇄형 인스턴스 — link-footer (사이드바 하단 'About / Privacy / Source' 안내)
// 완전 제거. CSS 숨김으로는 DOM 이 남아있어 SR/검색에 노출되므로 컴포넌트 자체를
// null 반환하게 만들어 출력 자체를 차단.
export const LinkFooter: React.FC<{
  multiColumn: boolean;
}> = () => null;
