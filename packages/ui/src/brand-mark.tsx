/** 客来答：用户选定的屋檐与对话框标识，使用 currentColor 适配蓝底与白底。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 100 84"
      fill="currentColor"
      focusable="false"
    >
      <path d="M23 4H77Q79 4 80 6L98 30Q100 34 96 34H84Q82 34 80 32L72 23H28L20 32Q18 34 15 34H4Q0 34 2 30L20 6Q21 4 23 4Z" />
      <path d="M16 39Q23 37 27 32V62H87Q89 62 89 64V79Q89 82 86 80L75 71H23Q16 71 16 64Z" />
    </svg>
  );
}
