import Link from "next/link";
import { clerkClient } from "@clerk/nextjs/server";

import { MAX_SIGNUP_ACCOUNTS } from "@/constants";
import { Button } from "@/components/ui/button";

import { SignUpForm } from "./sign-up-form";

// Gate signups behind a hard account cap. We hit the Clerk Backend API on
// every render of /sign-up so the cap is enforced even when the deployment
// scales horizontally — no extra database needed.
export default async function SignUpPage() {
  let userCount = 0;
  let countLookupFailed = false;

  try {
    const client = await clerkClient();
    userCount = await client.users.getCount();
  } catch (error) {
    // If Clerk is unreachable we fail OPEN (allow signup) rather than locking
    // everyone out — but we log the issue so you can spot it.
    console.error("[sign-up] Failed to fetch Clerk user count:", error);
    countLookupFailed = true;
  }

  if (!countLookupFailed && userCount >= MAX_SIGNUP_ACCOUNTS) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-xl border bg-card p-8 text-center shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">
          Sign-ups are closed
        </h1>
        <p className="text-sm text-muted-foreground">
          This preview is limited to{" "}
          <span className="font-medium">{MAX_SIGNUP_ACCOUNTS}</span> total
          accounts and we&apos;re currently at{" "}
          <span className="font-medium">{userCount}</span>. New registrations
          are temporarily disabled.
        </p>
        <p className="text-sm text-muted-foreground">
          If you already have an account, you can still sign in.
        </p>
        <Button asChild className="mt-2">
          <Link href="/sign-in">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  return <SignUpForm />;
}
