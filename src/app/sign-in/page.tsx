import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <main className="bg-muted flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-lg font-semibold">{PRODUCT_NAME}</h1>
          </CardTitle>
          <CardDescription>Sign in to your workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SignInForm />
          {google ? (
            <form action={signInWithGoogle}>
              <Button type="submit" variant="outline" className="w-full">
                Continue with Google
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
