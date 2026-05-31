// Small presentational pill marking a civic entity whose is_active = false.
// Mirrors the inline "Former" badge on the official detail header so the styling
// stays consistent. Rendered wherever the is_active gate relax (FIX-456) can now
// surface inactive/former entities to anon: the officials directory, the
// institutions hub, and institution detail headers (FIX-457). Active entities are
// the norm and render no badge — only "Former" is marked.
export function FormerBadge({
  isActive,
  className = "",
}: {
  isActive: boolean | null | undefined;
  className?: string;
}) {
  if (isActive !== false) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-500 ${className}`}
      title="No longer in office / inactive record"
    >
      Former
    </span>
  );
}
