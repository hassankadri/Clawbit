"use client";

import { cn } from "@/lib/utils";

interface UserAvatarProps {
  name?: string;
  imageUrl?: string | null;
  size?: "sm" | "md";
  className?: string;
}

const sizeClasses = {
  sm: "h-8 w-8 text-[13px]",
  md: "h-10 w-10 text-sm",
};

export default function UserAvatar({
  name = "Amaan Kadri",
  imageUrl,
  size = "md",
  className,
}: UserAvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || "A";

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/[0.06] bg-[#181b20] font-semibold text-white shadow-none ring-1 ring-black/10",
        sizeClasses[size],
        className,
      )}
      aria-label={`${name} profile avatar`}
    >
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        initial
      )}
    </span>
  );
}
