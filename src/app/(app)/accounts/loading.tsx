import { LoadingStatus, Skeleton } from "@/components/app/skeleton";

export default function Loading() {
  return (
    <div className="space-y-section">
      <LoadingStatus />
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-20 w-full rounded-lg" />
      <div className="space-y-2">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
