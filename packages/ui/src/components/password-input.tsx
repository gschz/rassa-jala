import { cn } from "@rassa-jala/ui/lib/utils";
import { Eye, EyeOff } from "lucide-react";
import * as React from "react";

import { Input } from "./input";

/**
 * Password input with a show/hide toggle (design doc §10). The toggle is a
 * native button overlaying the field: keyboard-operable, ≥44px touch target
 * and a visible focus ring, per §12.
 */
function PasswordInput({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative w-full">
      <Input type={visible ? "text" : "password"} className={cn("pr-11", className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex h-full w-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}

export { PasswordInput };
