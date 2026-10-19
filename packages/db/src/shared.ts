export * from "./shared/annotation-utils";
export * from "./shared/validation-utils";
export * from "./shared/aggregate-rules";
// Read seals and ciphertext-search checks — for sibling adapter plugins
// (e.g. the MongoDB plugin's Atlas Search annotations), since 0.1.162
export { ENCRYPTED_SEARCH_FEATURES } from "./shared/search-fields";
export {
  encryptedAncestorName,
  encryptedSearchProblem,
  encryptedTypeSearchProblem,
  viewFieldSeals,
  type TViewFieldSeals,
} from "./shared/view-validation";
