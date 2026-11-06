import { LoadingStatus, Skeleton } from "@/components/app/skeleton";

export default function Loading() {
  return (
    <div className="gap-section grid lg:grid-cols-2">
      <LoadingStatus />
      <Skeleton className="h-56 w-full rounded-lg" />
      <Skeleton className="h-56 w-full rounded-lg" />
    </div>
  );
}
