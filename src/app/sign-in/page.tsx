import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
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
    <main className="bg-background flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="surface-card rounded-2xl border border-border/80 p-8 shadow-sm space-y-6">
          <div className="flex flex-col items-center text-center space-y-3">
            <div
              className="size-11 rounded-xl bg-primary text-primary-foreground font-bold flex items-center justify-center text-lg shadow-xs"
              aria-hidden="true"
            >
              {PRODUCT_NAME.slice(0, 1)}
            </div>
            <div className="space-y-1">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">{PRODUCT_NAME}</h1>
              <p className="text-muted-foreground text-xs">Sign in to your workspace.</p>
            </div>
          </div>
          <div className="space-y-4">
            <SignInForm />
            {google ? (
              <form action={signInWithGoogle}>
                <Button type="submit" variant="outline" className="w-full h-9 text-xs">
                  Continue with Google
                </Button>
              </form>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
