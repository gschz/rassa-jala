import { ImageOff } from "lucide-react";
import { useState } from "react";

import { cn } from "@rassa-jala/ui/lib/utils";

/**
 * Product photo with a design-system fallback: renders a muted placeholder
 * whenever there is no src OR the image fails to load (e.g. 404 after a
 * missed upload) — never the browser's broken-image icon. Failure is tracked
 * per src, so fixing/re-uploading the image renders it again without a remount.
 */
export function ProductImage({
  src,
  alt,
  className,
  iconClassName,
}: Readonly<{
  src: string | null | undefined;
  alt: string;
  className?: string;
  iconClassName?: string;
}>) {
  const [srcFallado, setSrcFallado] = useState<string | null>(null);
  if (!src || srcFallado === src) {
    return (
      <div className={cn("flex items-center justify-center bg-muted", className)} aria-hidden>
        <ImageOff className={cn("size-5 text-muted-foreground", iconClassName)} aria-hidden />
      </div>
    );
  }
  return <img src={src} alt={alt} className={className} onError={() => setSrcFallado(src)} />;
}
