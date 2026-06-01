import classNames from 'classnames';

export const WordmarkLogo: React.FC = () => (
  <svg viewBox='0 0 261 66' className='logo logo--wordmark' role='img'>
    <title>Mastodon</title>
    <use xlinkHref='#logo-symbol-wordmark' />
  </svg>
);

// IconLogo / SymbolLogo 모두 PNG 직접 (`<img src='/icon-logo.png'>`).
// 이전 SVG embed (`<use href='#logo-symbol-icon'>` + symbol 안 image href) 의존
// 제거 — 일부 브라우저/CSP 환경에서 SVG 안 외부 image 가 표시 안 되는 경우 우회.
// 일관된 패턴 (img 직접) 으로 모든 logo--icon 사용처에서 PNG 그대로 표시.
export const IconLogo: React.FC<{ className?: string }> = ({ className }) => (
  <img
    src='/icon-logo.png'
    alt='Mastodon'
    className={classNames('logo logo--icon', className)}
  />
);

export const SymbolLogo: React.FC = () => (
  <img src='/icon-logo.png' alt='Mastodon' className='logo logo--icon' />
);
