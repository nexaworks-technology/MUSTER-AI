import type { Metadata } from "next";
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-md p-8 text-center space-y-4">
        <h1 className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
          Email Preferences
        </h1>
        <div
          className={`p-4 rounded-md text-sm ${
            isSuccess
              ? "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200"
              : "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200"
          }`}
        >
          {message}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          If you believe this was done in error or need further assistance, please contact customer support.
        </p>
      </div>
    </div>
  );
}
