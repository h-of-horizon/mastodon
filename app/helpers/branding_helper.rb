# frozen_string_literal: true

module BrandingHelper
  def logo_as_symbol(version = :icon)
    case version
    when :icon
      _logo_as_symbol_icon
    when :wordmark
      _logo_as_symbol_wordmark
    end
  end

  def _logo_as_symbol_wordmark
    tag.svg(viewBox: '0 0 261 66', class: 'logo logo--wordmark') do
      tag.title('Mastodon') +
        tag.use(href: '#logo-symbol-wordmark')
    end
  end

  # logo--icon 두 helper 모두 PNG 직접 (`/icon-logo.png`) 사용.
  # 이전 SVG embed (use href + symbol 안 image href) 의존 제거 — Rails view
  # (admin layout 등) 의 모든 logo 사용처에서 PNG 그대로 표시.
  # logo.tsx (React) 의 SymbolLogo/IconLogo 와 동일 패턴.
  def _logo_as_symbol_icon
    image_tag('/icon-logo.png', alt: 'Mastodon', class: 'logo logo--icon')
  end

  def render_logo
    image_tag('/icon-logo.png', alt: 'Mastodon', class: 'logo logo--icon')
  end
end
