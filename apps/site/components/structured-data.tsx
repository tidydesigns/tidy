const lessThanPattern = /</g;
export function StructuredData({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(lessThanPattern, "\\u003c") }}
    />
  );
}
