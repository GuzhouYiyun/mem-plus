import * as React from "react";
import { cn } from "$lib/utils";

// Plain inputs rather than radix wrappers: a text/number field needs no
// behaviour a div could not do, and the config form has ~28 of them.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        "border-input placeholder:text-muted-foreground dark:bg-input/30 flex h-8 w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-3",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        // Numbers read better without the spinner eating the field width.
        "[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
        className
      )}
      {...props}
    />
  );
}

export { Input };