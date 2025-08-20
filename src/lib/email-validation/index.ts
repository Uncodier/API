// Main validation functions
export { performSMTPValidation, detectCatchallDomain } from './smtp';
export { checkDomainExists, getMXRecords, attemptFallbackValidation } from './dns';
export { checkDomainReputation } from './reputation';

// Utility functions
export {
  isValidEmailFormat,
  extractDomain,
  isDisposableEmail,
  isLikelyNonEmailDomain,
  withDNSTimeout,
  createSocketWithTimeout,
  readSMTPResponse,
  sendSMTPCommand
} from './utils';

// Types
export type {
  MXRecord,
  SMTPResponse,
  EmailValidationResult
} from './utils';
