"use client";

import { SignUp } from "@clerk/nextjs";
import { dark } from "@clerk/themes";

import { useCurrentTheme } from "@/hooks/use-current-theme";

export function SignUpForm() {
  const currentTheme = useCurrentTheme();

  return (
    <SignUp
      appearance={{
        elements: {
          cardBox: "border! shadow-none! border-lg!",
        },
        baseTheme: currentTheme === "dark" ? dark : undefined,
      }}
    />
  );
}
