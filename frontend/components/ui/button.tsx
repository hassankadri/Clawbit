import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[16px] border text-sm font-medium transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px]",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[linear-gradient(135deg,rgba(139,92,246,1),rgba(168,85,247,1))] text-white shadow-[0_10px_24px_rgba(139,92,246,0.16)] hover:-translate-y-px hover:shadow-[0_14px_28px_rgba(139,92,246,0.2)]",
        outline:
          "border-[color:var(--border)] bg-[color:var(--surface)] text-[color:var(--foreground)] shadow-[0_10px_30px_rgba(15,23,42,0.06)] hover:-translate-y-px hover:border-[rgba(139,92,246,0.14)] hover:bg-[color:var(--accent-hover)]",
        secondary:
          "border-[color:var(--border)] bg-[color:var(--card)] text-[color:var(--foreground)] hover:-translate-y-px hover:bg-[color:var(--accent-hover)]",
        ghost:
          "border-transparent bg-transparent text-[color:var(--foreground)] hover:-translate-y-px hover:bg-[color:var(--accent-hover)]",
        destructive:
          "border-transparent bg-[rgba(239,68,68,0.1)] text-[rgb(220,38,38)] hover:-translate-y-px hover:bg-[rgba(239,68,68,0.14)]",
        link: "border-transparent bg-transparent p-0 text-[color:var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4",
        xs: "h-8 px-3 text-xs",
        sm: "h-9 px-3.5",
        lg: "h-11 px-5",
        icon: "size-10 p-0",
        "icon-xs": "size-8 p-0",
        "icon-sm": "size-9 p-0",
        "icon-lg": "size-11 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
