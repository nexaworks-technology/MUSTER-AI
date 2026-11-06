import { LoadingStatus, Skeleton } from "@/components/app/skeleton";

export default function Loading() {
  return (
    <div className="space-y-section max-w-3xl">
      <LoadingStatus />
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}
