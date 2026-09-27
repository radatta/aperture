// Minimal Plaid wire types — only the fields Aperture reads. Plaid-Version 2020-09-14. Amounts are
// float dollars on the wire (positive = money out of the account, per Plaid's transactions doc); they
// become integer cents at the boundary (toFinanceTxn) and never travel as floats past it.

export interface PlaidPersonalFinanceCategory {
  primary: string;
  detailed: string;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string; // YYYY-MM-DD
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  payment_channel: string | null;
  personal_finance_category: PlaidPersonalFinanceCategory | null;
}

export interface PlaidSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string; // depository | credit | loan | investment | other
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    iso_currency_code: string | null;
  };
}

export interface PlaidItemStatus {
  item_id: string;
  institution_id: string | null;
  consented_products?: string[];
  consent_expiration_time: string | null; // ISO-8601
  error: PlaidError | null;
}

export interface PlaidError {
  error_type: string;
  error_code: string;
  error_message: string;
  request_id?: string;
}

// The onSuccess metadata Link hands the browser. `accounts` is what the user ticked.
export interface LinkSuccessMetadata {
  institution: { institution_id: string; name: string } | null;
  accounts: {
    id: string;
    name: string;
    mask: string | null;
    type: string;
    subtype: string | null;
  }[];
}
