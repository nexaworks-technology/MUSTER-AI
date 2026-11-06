/**
 * What the workspace export leaves out or rewrites (M12 B1, D-179; Rules 8 and 9).
 * Listed here once: the job applies it, the manifest prints it, and the tests check the schema
 * for any new column that looks sensitive and is not named here.
 */
export interface ExcludedColumn {
  model: string;
  column: string;
  reason: string;
}

export const EXCLUDED_COLUMNS: readonly ExcludedColumn[] = [
  {
    model: "Integration",
    column: "credentialsEnc",
    reason:
      "Provider tokens and API keys are credentials, not workspace data. Reconnect after any restore.",
  },
  {
    model: "Integration",
    column: "ingestKeyHash",
    reason: "A hash of the Usage API ingest key; it would let a copy be checked against live keys.",
  },
  {
    model: "Integration",
    column: "ingestKeyLast4",
    reason:
      "The last four characters of the ingest key; left out with the key so the pair stays consistent (the database requires both or neither).",
  },
  {
    model: "Invitation",
    column: "tokenHash",
    reason: "A hash of an invitation link token; it is a credential for joining the workspace.",
  },
  {
    model: "PortalAccess",
    column: "tokenHash",
    reason: "A hash of a customer portal magic-link token; it is a credential for the portal.",
  },
  {
    model: "SurveyResponse",
    column: "token",
    reason: "The one-time survey link token; it is a credential for answering that survey.",
  },
];

export interface DecryptedField {
  /** The stored ciphertext column, left out of the export. */
  column: string;
  /** The exported plaintext key. */
  exportedAs: string;
}

/** Field-encrypted columns that are the customer's own data: exported decrypted. */
export const DECRYPTED_FIELDS: Readonly<Record<string, readonly DecryptedField[]>> = {
  Contract: [
    { column: "termsEnc", exportedAs: "terms" },
    { column: "pricingNotesEnc", exportedAs: "pricingNotes" },
  ],
};

/** Not exported at all because they are not workspace data. */
export const NOT_EXPORTED = [
  "User, AuthAccount, Session and VerificationToken: sign-in identities and session tokens belong to the person, not the workspace; password hashes and session tokens are never exported.",
  "OutboxEvent: internal delivery queue.",
] as const;
