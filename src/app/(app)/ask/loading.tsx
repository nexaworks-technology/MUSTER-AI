import { LoadingStatus, Skeleton } from "@/components/app/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4">
      <LoadingStatus />
      <div className="space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
