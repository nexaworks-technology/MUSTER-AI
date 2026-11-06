import Link from "next/link";

/**
 * M12 B7: the app's own 404. Next's built-in one injects a <style> without the request nonce, which
 * the production CSP (D-175) refuses, so every 404 rendered unstyled and raised a violation.
 */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-md space-y-3 p-8">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground text-sm">
        This page does not exist, or your role does not include it.
      </p>
      <Link href="/today" className="text-sm underline">
        Go to Today
      </Link>
    </main>
  );
}
