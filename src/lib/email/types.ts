/** Internal staff email (invitations, digests to our customer's own users). */
export interface StaffEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailTransport {
  readonly name: "log" | "resend";
  send(message: StaffEmail): Promise<{ id: string }>;
}
