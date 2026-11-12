import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { BrandSplit } from "@/components/brand/brand-split";
import { PRODUCT_NAME } from "@/config/product";
import { isGoogleConfigured } from "@/lib/auth/config";
import { getSession } from "@/lib/auth/session";
import { signInWithGoogle } from "./actions";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  if (await getSession()) redirect("/today");
  const google = isGoogleConfigured();

  return (
    <BrandSplit wordmarkAs="h1">
      <div className="space-y-8">
        <div className="space-y-2">
          <h2 className="font-display text-foreground text-3xl font-semibold tracking-tight">
            Welcome back
          </h2>
          <p className="text-muted-foreground text-sm">Sign in to your {PRODUCT_NAME} account.</p>
        </div>
        <div className="space-y-4">
          <SignInForm />
          {google ? (
            <form action={signInWithGoogle}>
              <Button type="submit" variant="outline" className="h-10 w-full rounded-lg text-sm">
                Continue with Google
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </BrandSplit>
  );
}
