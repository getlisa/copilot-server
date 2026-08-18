import assert from "node:assert";
import { draftProposalEmail } from "../src/copilot/estimating/proposalEmail";

const base = {
  header: {
    companyName: "Acme Electric",
    companyAddress: "",
    companyPhone: "",
    companyEmail: "",
    customerName: "Jane Doe",
    billingAddress: "",
    serviceAddress: "",
    technicianName: "Sam",
    logoUrl: null,
    licenseNumber: "",
  },
  projectTitle: "Panel Upgrade",
  lineItems: [],
  total: 1825,
};

// No template → built-in letter.
const def = draftProposalEmail(base);
assert.ok(def.body.startsWith("Dear Jane Doe,"));
assert.ok(def.subject.includes("Acme Electric"));

// Template wins; placeholders substituted, unknown ones left visible.
const t = draftProposalEmail({
  ...base,
  template: "Hi {{customerName}} — {{projectTitle}} costs {{total}}.\n{{summary}}\n{{bogus}}",
});
assert.ok(t.body.includes("Hi Jane Doe — Panel Upgrade costs $1,825.00."));
assert.ok(t.body.includes("Total: $1,825.00")); // {{summary}} block
assert.ok(t.body.includes("{{bogus}}")); // typo stays visible in the reviewable draft

// Blank template falls back to the default.
assert.ok(draftProposalEmail({ ...base, template: "   " }).body.startsWith("Dear Jane Doe,"));

console.log("check-proposal-email: OK");
