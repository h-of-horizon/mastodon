import classNames from 'classnames';

export const WordmarkLogo: React.FC = () => (
  <svg viewBox='0 0 261 66' className='logo logo--wordmark' role='img'>
    <title>Mastodon</title>
    <use xlinkHref='#logo-symbol-wordmark' />
  </svg>
);

export const IconLogo: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox='0 0 79 79'
    className={classNames('logo logo--icon', className)}
    role='img'
  >
    <title>Mastodon</title>
    <use xlinkHref='#logo-symbol-icon' />
  </svg>
);

// SymbolLogo 는 `<img>` 직접 — PNG 사용 (public/icon-logo.png).
// `<img src={svgFile}>` 컨텍스트에서 SVG 안 외부 image href 가 일부 브라우저에서
// 차단될 수 있어 PNG 직접 사용으로 우회 (logo--icon 클래스는 IconLogo 와 공유).
export const SymbolLogo: React.FC = () => (
  <img src='/icon-logo.png' alt='Mastodon' className='logo logo--icon' />
);
