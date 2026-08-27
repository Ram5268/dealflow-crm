// Contract-path re-export of the DNC mock vendor. Source of truth lives in the
// slice (src/lib/compliance/dnc/vendors/mock.ts) so the factory can load it
// without a src→contracts import; this shim exists for the brief's file layout
// and any consumer that imports the mock by contract path.
export { mockDncVendor, makeMockDncVendor, DEFAULT_BLOCKED } from '../../../../src/lib/compliance/dnc/vendors/mock'
