/**
 * The QA-Core mark: an isometric cube in the SprintSynergy pair, flat shaded
 * (top mint, left teal, right deep teal), static, readable at 16 px. The same
 * geometry is public/favicon.svg; keep the two in step.
 */
export const BRAND_TEAL = '#076887';
export const BRAND_MINT = '#59DFCF';
export const BRAND_DEEP = '#05485E';

export function BrandMark({ size = 22, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title} focusable="false">
      <polygon points="16,3 27.3,9.5 16,16 4.7,9.5" fill={BRAND_MINT} />
      <polygon points="4.7,9.5 16,16 16,29 4.7,22.5" fill={BRAND_TEAL} />
      <polygon points="16,16 27.3,9.5 27.3,22.5 16,29" fill={BRAND_DEEP} />
    </svg>
  );
}
