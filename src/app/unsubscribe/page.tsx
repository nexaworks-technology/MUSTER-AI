import type { Metadata } from "next";
import { MailCheck, MailX } from "lucide-react";
import { Card } from "@/components/ui/card";
import { processUnsubscribe } from "@/modules/campaigns/service";

export const metadata: Metadata = {
  title: "Unsubscribe | NexaWorks",
};

interface UnsubscribePageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function UnsubscribePage({ searchParams }: UnsubscribePageProps) {
  const params = await searchParams;
  const token = params.token;

  let message = "Processing your request...";
  let isSuccess = false;

  if (!token) {
    message = "No unsubscribe token provided. If you followed a link, please check the URL.";
  } else {
    const res = await processUnsubscribe(token);
    if (res.success) {
      isSuccess = true;
      message = `You have been unsubscribed (${res.email}). You will no longer receive marketing and campaign emails.`;
    } else {
      message = res.error || "The unsubscribe link is invalid or has expired.";
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-10 md:py-16">
      <Card className="w-full items-center gap-4 px-6 py-8 text-center md:px-10 md:py-12">
        <span
          className={`flex size-12 items-center justify-center rounded-full ${
            isSuccess
              ? "bg-success-soft text-success-soft-foreground"
              : "bg-warning-soft text-warning-soft-foreground"
          }`}
          aria-hidden="true"
        >
          {isSuccess ? <MailCheck className="size-5" /> : <MailX className="size-5" />}
        </span>
        <h1 className="text-xl font-semibold tracking-tight">Email Preferences</h1>
        <div
          className={`w-full rounded-md px-4 py-3 text-sm leading-relaxed ${
            isSuccess
              ? "bg-success-soft text-success-soft-foreground"
              : "bg-warning-soft text-warning-soft-foreground"
          }`}
        >
          {message}
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">
          If you believe this was done in error or need further assistance, please contact customer
          support.
        </p>
      </Card>
    </main>
  );
}
