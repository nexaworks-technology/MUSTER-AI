import { PRODUCT_NAME } from "@/config/product";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">{PRODUCT_NAME}</h1>
    </main>
  );
}
