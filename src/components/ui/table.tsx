import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Table primitives. The look (muted sticky header, row hover, cell padding, tabular numbers) comes
 * from the global table rules in src/app/globals.css, so a plain <table> and these render alike.
 * Right-align a numeric column with className="text-right" on its TableHead and TableCell.
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="border-border w-full overflow-x-auto rounded-lg border"
    >
      <table data-slot="table" className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader(props: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" {...props} />;
}

function TableBody(props: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" {...props} />;
}

function TableRow(props: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return <th data-slot="table-head" className={className} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" className={className} {...props} />;
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
