#![cfg_attr(not(feature = "std"), no_std, no_main)]
#![allow(clippy::arithmetic_side_effects, clippy::new_without_default)]

#[ink::contract]
mod dex_swap {
    use ink::storage::Mapping;

    #[derive(scale::Encode, scale::Decode, Debug, PartialEq, Eq)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum Error {
        ZeroLiquidity,
        ZeroShares,
        InsufficientShares,
        ZeroInput,
        InsufficientLiquidity,
        InsufficientOutput,
    }

    pub type Result<T> = core::result::Result<T, Error>;

    #[ink(storage)]
    pub struct DexSwap {
        reserve_a: Balance,
        reserve_b: Balance,
        total_shares: Balance,
        shares: Mapping<AccountId, Balance>,
    }

    impl DexSwap {
        #[ink(constructor)]
        pub fn new() -> Self {
            Self {
                reserve_a: 0,
                reserve_b: 0,
                total_shares: 0,
                shares: Mapping::default(),
            }
        }

        #[ink(message)]
        pub fn add_liquidity(&mut self, user: AccountId, amount_a: Balance, amount_b: Balance) -> Result<Balance> {
            if amount_a == 0 || amount_b == 0 {
                return Err(Error::ZeroLiquidity);
            }
            let minted = if self.total_shares == 0 {
                amount_a.saturating_add(amount_b)
            } else {
                let share_a = amount_a.saturating_mul(self.total_shares) / self.reserve_a;
                let share_b = amount_b.saturating_mul(self.total_shares) / self.reserve_b;
                core::cmp::min(share_a, share_b)
            };
            if minted == 0 {
                return Err(Error::ZeroShares);
            }
            self.reserve_a = self.reserve_a.saturating_add(amount_a);
            self.reserve_b = self.reserve_b.saturating_add(amount_b);
            self.total_shares = self.total_shares.saturating_add(minted);
            self.shares.insert(user, &(self.get_shares(user).saturating_add(minted)));
            Ok(minted)
        }

        #[ink(message)]
        pub fn remove_liquidity(&mut self, user: AccountId, share_amount: Balance) -> Result<(Balance, Balance)> {
            if share_amount == 0 {
                return Err(Error::ZeroShares);
            }
            let current = self.get_shares(user);
            if current < share_amount {
                return Err(Error::InsufficientShares);
            }
            let amount_a = self.reserve_a.saturating_mul(share_amount) / self.total_shares;
            let amount_b = self.reserve_b.saturating_mul(share_amount) / self.total_shares;
            self.shares.insert(user, &(current - share_amount));
            self.total_shares -= share_amount;
            self.reserve_a -= amount_a;
            self.reserve_b -= amount_b;
            Ok((amount_a, amount_b))
        }

        #[ink(message)]
        pub fn swap_a_for_b(&mut self, _user: AccountId, amount_in: Balance) -> Result<Balance> {
            if amount_in == 0 {
                return Err(Error::ZeroInput);
            }
            if self.reserve_a == 0 || self.reserve_b == 0 {
                return Err(Error::InsufficientLiquidity);
            }
            let amount_in_with_fee = amount_in.saturating_mul(997);
            let amount_out = amount_in_with_fee.saturating_mul(self.reserve_b)
                / (self.reserve_a.saturating_mul(1000).saturating_add(amount_in_with_fee));
            if amount_out == 0 || amount_out >= self.reserve_b {
                return Err(Error::InsufficientOutput);
            }
            self.reserve_a = self.reserve_a.saturating_add(amount_in);
            self.reserve_b -= amount_out;
            Ok(amount_out)
        }

        #[ink(message)]
        pub fn get_reserves(&self) -> (Balance, Balance) {
            (self.reserve_a, self.reserve_b)
        }

        #[ink(message)]
        pub fn get_shares(&self, user: AccountId) -> Balance {
            self.shares.get(user).unwrap_or(0)
        }

        #[ink(message)]
        pub fn total_shares(&self) -> Balance {
            self.total_shares
        }

        #[ink(message)]
        pub fn rq2_reset(&mut self) {
            self.reserve_a = 0;
            self.reserve_b = 0;
            self.total_shares = 0;
        }
    }
}
