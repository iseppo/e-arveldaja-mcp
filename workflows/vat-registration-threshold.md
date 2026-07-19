# VAT Registration Threshold

Check whether a non-VAT-registered Estonian company may need to register as a VAT payer after crossing the {{E_ARVELDAJA_VAT:THRESHOLD_DISPLAY}} calendar-year threshold.

This workflow is read-only. It presents dated informational facts and an advisory compliance check, not a hard legal decision or a substitute for fact-specific professional advice. The VAT facts below were verified on {{E_ARVELDAJA_VAT:VERIFIED_DATE}}.

## Legal scope

Under the scope effective {{E_ARVELDAJA_VAT:SCOPE_EFFECTIVE_DATE}}, the {{E_ARVELDAJA_VAT:THRESHOLD_DISPLAY}} threshold includes:

- taxable turnover, including 0% turnover, except fixed-asset disposals
- non-incidental real-estate turnover covered by KMS §16(2) points 2, 3, and 6
- non-incidental insurance-services turnover
- non-incidental financial-services turnover

The threshold does not include:

- social-type exempt services such as healthcare or education
- fixed-asset disposals
- incidental real-estate, insurance, or financial transactions
- turnover whose place of supply is not Estonia

Current Estonian VAT rates in this dated metadata are {{E_ARVELDAJA_VAT:CURRENT_RATES}}. The standard rate is {{E_ARVELDAJA_VAT:STANDARD_RATE}}, effective from {{E_ARVELDAJA_VAT:STANDARD_RATE_EFFECTIVE_DATE}}. Do not infer the correct rate or input-VAT deductibility for a fact-specific transaction without reviewing its date, supply, and restrictions.

Official EMTA sources:

- Registration threshold and scope: {{E_ARVELDAJA_VAT:THRESHOLD_SOURCE_URL}}
- VAT rates: {{E_ARVELDAJA_VAT:RATES_SOURCE_URL}}
- Input-VAT deduction restrictions: {{E_ARVELDAJA_VAT:INPUT_VAT_RESTRICTIONS_SOURCE_URL}}

## Workflow

1. Call `check_vat_registration_threshold` for the requested year.
2. If the user mentioned finance, insurance, real estate, exempt services, or incidental transactions, pass those amounts in the matching arguments:
   - `financial_turnover`
   - `insurance_turnover`
   - `real_estate_turnover`
   - `exempt_social_turnover`
   - `incidental_excluded_turnover`
   - `taxable_turnover_adjustment`
   - `manual_bucket_source`
3. Set `manual_bucket_source` carefully:
   - use `outside_sale_invoices` when the manual bucket amounts are not already included in confirmed sale invoices
   - use `included_in_sale_invoices` when the manual bucket amounts are a reclassification of confirmed sale-invoice turnover; this prevents double counting
4. Review `status`:
   - `already_registered`: company already has a VAT number
   - `exceeded`: ordinary taxable/0% turnover alone exceeds {{E_ARVELDAJA_VAT:THRESHOLD_DISPLAY}}
   - `needs_manual_review`: threshold depends on non-incidental finance, insurance, or real-estate turnover
   - `approaching`: monitor the next invoices and turnover buckets
   - `ok`: no threshold issue from supplied data
5. If `needs_manual_review`, ask the user to classify the relevant turnover as incidental or non-incidental before concluding registration duty.

## Output

Summarize:

- VAT registration status
- confirmed sale-invoice turnover for the year
- whether manual bucket amounts were outside sale invoices or reclassified from sale invoices
- ordinary sale-invoice turnover after any manual bucket reclassification
- finance, insurance, and real-estate turnover that would count if not incidental
- turnover explicitly not counted
- threshold total and excess/remaining amount
- the specific manual review questions that decide the result

Do not create, update, confirm, send, or delete records in this workflow.
