export function TidyLogo({ className = "" }: { className?: string }) {
  return (
    <span
      data-ph-public
      className={`inline-block font-serif text-[34px] leading-[0.98] tracking-[-0.02em] text-ink ${className}`}
    >
      Tidy
    </span>
  );
}
