"use client";

import { useActionState, useState } from "react";
import { NativeSelect } from "@/components/app/native-select";
import { FormMessage } from "@/components/app/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { generateQbrAction, type QbrActionState } from "@/modules/qbr/actions";

/** Account + period, then the real `generateQbr` (M12 C0a). */
export function QbrForm({ accounts }: { accounts: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState<QbrActionState, FormData>(generateQbrAction, {});
  // Controlled, so a refused attempt keeps the member's choices (React resets uncontrolled forms
  // after an action; the account would silently snap back to the first one).
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [period, setPeriod] = useState("Q3 2026");
  return (
    <form action={action} className="surface space-y-4 p-5" aria-label="New QBR">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="account-select" className="mb-1 block text-sm font-medium">
            Account
          </label>
          <NativeSelect
            id="account-select"
            name="accountId"
            data-testid="qbr-account-select"
            className="w-full"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div>
          <label htmlFor="period-input" className="mb-1 block text-sm font-medium">
            Period (e.g. Q3 2026)
          </label>
          <Input
            id="period-input"
            name="period"
            data-testid="qbr-period-input"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            required
          />
          <p className="text-muted-foreground mt-1 text-xs">
            A quarter like &quot;Q3 2026&quot; or a date like &quot;2026-09-30&quot;.
          </p>
        </div>
      </div>
      <Button type="submit" disabled={pending || accounts.length === 0}>
        {pending ? "Generating…" : "Generate QBR"}
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
