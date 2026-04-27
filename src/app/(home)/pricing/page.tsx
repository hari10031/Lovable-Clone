"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import Image from "next/image";
import { useRouter } from "next/navigation";

import {
  FREE_PLAN_POINTS,
  PRO_PLAN_POINTS,
  PRO_PLAN_PRICE_USD,
} from "@/constants";

export default function PricingPage() {
  const router = useRouter();
  const clerk = useClerk();
  const { has, isSignedIn } = useAuth();
  const hasProAccess = has?.({ plan: "pro" }) ?? false;

  const handleProAction = () => {
    if (!isSignedIn) {
      clerk.openSignIn();
      return;
    }

    clerk.openUserProfile();
  };

  return (
    <div className="flex flex-col max-w-4xl mx-auto w-full px-4">
      <section className="space-y-8 pt-[12vh] 2xl:pt-40 pb-16">
        <div className="flex flex-col items-center">
          <Image
            src="/logo.svg"
            alt="lovable-clone"
            height={50}
            width={50}
            className="hidden md:block"
          />
          <h1 className="text-xl md:text-3xl font-bold text-center mt-4">
            Pricing
          </h1>
          <p className="text-muted-foreground text-center text-sm md:text-base">
            Choose the plan that fits your needs
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
          {/* Free Plan */}
          <div className="border rounded-lg p-6 flex flex-col gap-4 bg-card">
            <div>
              <h2 className="text-lg font-semibold">Free</h2>
              <p className="text-muted-foreground text-sm mt-1">
                Get started building with AI
              </p>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-bold">$0</span>
              <span className="text-muted-foreground text-sm">/ month</span>
            </div>
            <ul className="space-y-2 text-sm flex-1">
              <li className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                {FREE_PLAN_POINTS.toLocaleString()} generations per month
              </li>
              <li className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                Access to all models
              </li>
              <li className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                Community support
              </li>
            </ul>
            <button
              onClick={() => router.push("/")}
              className="w-full py-2 px-4 border rounded-lg text-sm font-medium hover:bg-accent transition-colors cursor-pointer"
            >
              {hasProAccess ? "Switch to Workspace" : "Continue on Free"}
            </button>
          </div>

          {/* Pro Plan */}
          <div className="border-2 border-primary rounded-lg p-6 flex flex-col gap-4 bg-card relative">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">
              Popular
            </div>
            <div>
              <h2 className="text-lg font-semibold">Pro</h2>
              <p className="text-muted-foreground text-sm mt-1">
                For serious builders
              </p>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-bold">${PRO_PLAN_PRICE_USD}</span>
              <span className="text-muted-foreground text-sm">/ month</span>
            </div>
            <ul className="space-y-2 text-sm flex-1">
              <li className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                {PRO_PLAN_POINTS.toLocaleString()} generations per month
              </li>
              <li className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                Access to all models
              </li>
              <li className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                Priority support
              </li>
              <li className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                Advanced features
              </li>
            </ul>
            <button
              className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
              onClick={handleProAction}
            >
              {hasProAccess ? "Manage Billing" : "Upgrade with Clerk"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
