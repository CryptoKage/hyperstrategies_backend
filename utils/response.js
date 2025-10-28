// hyperstrategies_backend/utils/response.js

/**
 * Creates a standardized success response object.
 * @param {string} code - A unique code for the successful action (e.g., 'PROFILE_SAVED').
 * @param {object} [params={}] - Optional dynamic variables for the frontend toast message.
 * @param {object} [extra={}] - Any additional data to send back to the frontend.
 * @returns {object} The standardized success object.
 */
const ok = (code, params = {}, extra = {}) => {
  return {
    ok: true,
    code,
    params,
    ...extra
  };
};

/**
 * Creates a standardized error response object.
 * @param {string} code - A unique code for the error (e.g., 'USERNAME_TAKEN').
 * @param {object} [params={}] - Optional dynamic variables for the frontend toast message.
 * @returns {object} The standardized error object.
 */
const fail = (code, params = {}) => {
  return {
    ok: false,
    code,
    params
  };
};

module.exports = {
  ok,
  fail,
};
