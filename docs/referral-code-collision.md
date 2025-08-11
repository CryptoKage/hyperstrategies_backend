# Referral Code Collision Handling

Referral codes are randomly generated strings prefixed with `HS-`. To avoid
accidental collisions:

1. `generateUniqueReferralCode` checks the `users` table for the generated code
   and regenerates if one already exists.
2. During user creation and when assigning a code to OAuth users, insertion or
   update statements are retried if the database reports a unique constraint
   violation for `referral_code`.

This looped retry approach ensures that every user ultimately receives a unique
referral code even in the unlikely event of simultaneous code generation.

