import Link from "next/link";
import { Compass } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * M12 B7: the app's own 404. Next's built-in one injects a <style> without the request nonce, which
 * the production CSP (D-175) refuses, so every 404 rendered unstyled and raised a violation.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4 py-10 md:py-16">
      <Card className="w-full items-center gap-3 px-6 py-10 text-center md:px-10 md:py-12">
        <span
          className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full"
          aria-hidden="true"
        >
          <Compass className="size-5" />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          This page does not exist, or your role does not include it.
        </p>
        <Link href="/today" className={buttonVariants({ variant: "outline", className: "mt-2" })}>
          Go to Today
        </Link>
      </Card>
    </main>
  );
}
