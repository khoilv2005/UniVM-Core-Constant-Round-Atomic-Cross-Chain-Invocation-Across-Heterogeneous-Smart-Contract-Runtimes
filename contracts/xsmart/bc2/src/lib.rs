//! TrainBooking — WASM smart contract on bc2 (Substrate ink!) for XSmartContract.
//!
//! Cross-chain interface mirrors Solidity STrain.sol+LTrain.sol so that
//! XSmartContract's UBTL can translate this WASM bytecode into EVM bytecode
//! and execute it on bc1.
//!
//! Primitives: lock_state / update_state / unlock_state / unlock_on_timeout /
//! book_local — all keyed by `crosschain_tx_id` (u64) per IntegrateX paper §V-A.

#![cfg_attr(not(feature = "std"), no_std, no_main)]

mod vassp;

#[ink::contract]
mod train_booking {
    use crate::vassp;
    use ink::prelude::vec;
    use ink::prelude::vec::Vec;
    use ink::storage::Mapping;

    const TRAIN_CONTRACT_NAME: &str = "TrainBooking";

    #[derive(scale::Encode, scale::Decode, Default, Clone)]
    #[cfg_attr(
        feature = "std",
        derive(scale_info::TypeInfo, ::ink::storage::traits::StorageLayout)
    )]
    pub struct LockEntry {
        pub locked_amount: Balance,
        pub lock_block: BlockNumber,
        pub timeout_blocks: BlockNumber,
        pub active: bool,
    }

    #[derive(scale::Encode, scale::Decode, Debug, PartialEq, Eq)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum Error {
        NotBridge, ZeroAmount, InsufficientRemain,
        AlreadyLocked, NotLocked, NotTimedOut,
    }
    pub type Result<T> = core::result::Result<T, Error>;

    #[ink(storage)]
    pub struct TrainBooking {
        bridge: AccountId,
        price: Balance,
        remain: u64,
        ir_hash: Hash,
        locks: Mapping<u64, LockEntry>,
        locked_total: Balance,
        accounts: Mapping<AccountId, Balance>,
        bookings: Mapping<AccountId, u64>,
        lock_size: u64,
    }

    #[ink(event)] pub struct StateLocked {
        #[ink(topic)] crosschain_tx_id: u64, amount: Balance, timeout_blocks: BlockNumber,
    }
    #[ink(event)] pub struct StateUpdated {
        #[ink(topic)] crosschain_tx_id: u64,
        new_remain: u64, user: AccountId, num: u64, total_cost: Balance,
    }
    #[ink(event)] pub struct StateUnlocked { #[ink(topic)] crosschain_tx_id: u64 }

    impl TrainBooking {
        #[ink(constructor)]
        pub fn new(
            bridge: AccountId,
            price: Balance,
            remain: u64,
            lock_size: u64,
            ir_hash: Hash,
        ) -> Self {
            assert!(price > 0, "price must be > 0");
            Self { bridge, price, remain, ir_hash, locks: Mapping::default(),
                   locked_total: 0, accounts: Mapping::default(),
                   bookings: Mapping::default(), lock_size }
        }

        #[ink(message)] pub fn ir_hash(&self) -> Hash { self.ir_hash }
        #[ink(message)] pub fn get_price(&self) -> Balance { self.price }
        #[ink(message)] pub fn get_remain(&self) -> u64 { self.remain }
        #[ink(message)] pub fn get_locked_total(&self) -> Balance { self.locked_total }
        #[ink(message)] pub fn get_lock_amount(&self, id: u64) -> Balance {
            self.locks.get(id).map(|l| l.locked_amount).unwrap_or(0)
        }
        #[ink(message)] pub fn get_available_remain(&self) -> u64 {
            let locked_units_u128 = self.locked_total.checked_div(self.price).unwrap_or(0);
            let locked_units = u64::try_from(locked_units_u128).unwrap_or(u64::MAX);
            self.remain.saturating_sub(locked_units)
        }
        #[ink(message)] pub fn get_account_balance(&self, user: AccountId) -> Balance {
            self.accounts.get(user).unwrap_or(0)
        }
        #[ink(message)] pub fn get_booking(&self, user: AccountId) -> u64 {
            self.bookings.get(user).unwrap_or(0)
        }
        #[ink(message)] pub fn is_state_locked(&self, id: u64) -> bool {
            self.locks.get(id).map(|l| l.active).unwrap_or(false)
        }
        #[ink(message)]
        pub fn vassp_encode_state(&self, _id: u64) -> Vec<u8> {
            let pairs = vec![
                (
                    vassp::slot_id_for(TRAIN_CONTRACT_NAME, "price", &[]),
                    vassp::encode_uint256_u128(self.price),
                ),
                (
                    vassp::slot_id_for(TRAIN_CONTRACT_NAME, "remain", &[]),
                    vassp::encode_uint256_u64(self.remain),
                ),
                (
                    vassp::slot_id_for(TRAIN_CONTRACT_NAME, "lock_size", &[]),
                    vassp::encode_uint256_u64(self.lock_size),
                ),
                (
                    vassp::slot_id_for(TRAIN_CONTRACT_NAME, "locked_total", &[]),
                    vassp::encode_uint256_u128(self.locked_total),
                ),
            ];
            vassp::encode(&pairs)
        }

        #[ink(message)]
        pub fn book_local(&mut self, user: AccountId, num: u64) -> Result<Balance> {
            if num == 0 { return Err(Error::ZeroAmount); }
            if self.get_available_remain() < num { return Err(Error::InsufficientRemain); }
            let cost = self.price.saturating_mul(num as Balance);
            self.remain = self.remain.saturating_sub(num);
            let cur = self.accounts.get(user).unwrap_or(0);
            self.accounts.insert(user, &cur.saturating_add(cost));
            let bk = self.bookings.get(user).unwrap_or(0);
            self.bookings.insert(user, &bk.saturating_add(num));
            Ok(cost)
        }

        #[ink(message)]
        pub fn lock_state(&mut self, id: u64, num: u64, timeout: BlockNumber)
            -> Result<(Vec<u8>, Hash, Vec<u8>)>
        {
            self.ensure_bridge()?;
            if self.locks.get(id).map(|l| l.active).unwrap_or(false) {
                return Err(Error::AlreadyLocked);
            }
            if self.get_available_remain() < num { return Err(Error::InsufficientRemain); }
            let amt = if num > 0 { self.price.saturating_mul(num as Balance) }
                      else { self.price.saturating_mul(self.lock_size as Balance) };
            self.locks.insert(id, &LockEntry {
                locked_amount: amt, lock_block: self.env().block_number(),
                timeout_blocks: timeout, active: true,
            });
            self.locked_total = self.locked_total.saturating_add(amt);
            self.env().emit_event(StateLocked { crosschain_tx_id: id, amount: amt, timeout_blocks: timeout });
            Ok((self.vassp_encode_state(id), self.ir_hash, Vec::new()))
        }

        #[ink(message)]
        pub fn update_state(&mut self, id: u64, new_remain: u64,
                            user: AccountId, num: u64, total_cost: Balance) -> Result<()>
        {
            self.ensure_bridge()?;
            self.unlock_internal(id)?;
            self.remain = new_remain;
            let cur = self.accounts.get(user).unwrap_or(0);
            self.accounts.insert(user, &cur.saturating_add(total_cost));
            let bk = self.bookings.get(user).unwrap_or(0);
            self.bookings.insert(user, &bk.saturating_add(num));
            self.env().emit_event(StateUpdated {
                crosschain_tx_id: id, new_remain, user, num, total_cost
            });
            Ok(())
        }

        #[ink(message)]
        pub fn unlock_state(&mut self, id: u64) -> Result<()> {
            self.ensure_bridge()?;
            self.unlock_internal(id)?;
            self.env().emit_event(StateUnlocked { crosschain_tx_id: id });
            Ok(())
        }

        #[ink(message)]
        pub fn unlock_on_timeout(&mut self, id: u64) -> Result<()> {
            let e = self.locks.get(id).ok_or(Error::NotLocked)?;
            if !e.active { return Err(Error::NotLocked); }
            if self.env().block_number() <= e.lock_block.saturating_add(e.timeout_blocks) {
                return Err(Error::NotTimedOut);
            }
            self.locked_total = self.locked_total.saturating_sub(e.locked_amount);
            self.locks.remove(id);
            self.env().emit_event(StateUnlocked { crosschain_tx_id: id });
            Ok(())
        }

        #[ink(message)] pub fn set_bridge(&mut self, b: AccountId) -> Result<()> {
            self.ensure_bridge()?; self.bridge = b; Ok(())
        }

        #[ink(message)]
        pub fn rq2_reset(&mut self, bridge: AccountId, price: Balance, remain: u64, lock_size: u64) -> Result<()> {
            self.ensure_bridge()?;
            self.bridge = bridge;
            self.price = price;
            self.remain = remain;
            self.lock_size = if lock_size == 0 { 1 } else { lock_size };
            self.locked_total = 0;
            Ok(())
        }

        fn ensure_bridge(&self) -> Result<()> {
            if self.env().caller() == self.bridge { Ok(()) } else { Err(Error::NotBridge) }
        }
        fn unlock_internal(&mut self, id: u64) -> Result<()> {
            let e = self.locks.get(id).ok_or(Error::NotLocked)?;
            if !e.active { return Err(Error::NotLocked); }
            self.locked_total = self.locked_total.saturating_sub(e.locked_amount);
            self.locks.remove(id);
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn alice() -> AccountId { AccountId::from([1u8;32]) }
        fn bob() -> AccountId { AccountId::from([2u8;32]) }
        fn ir_hash() -> Hash { [7u8;32].into() }

        #[ink::test] fn book_local_works() {
            let mut c = TrainBooking::new(alice(), 10, 100, 1, ir_hash());
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(bob());
            assert_eq!(c.book_local(bob(), 3).unwrap(), 30);
            assert_eq!(c.get_remain(), 97);
        }
        #[ink::test] fn lock_then_update() {
            let mut c = TrainBooking::new(alice(), 10, 100, 1, ir_hash());
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(alice());
            let (encoded, returned_hash, proof) = c.lock_state(1, 5, 10).unwrap();
            assert!(!encoded.is_empty());
            assert_eq!(returned_hash, ir_hash());
            assert!(proof.is_empty());
            c.update_state(1, 95, bob(), 5, 50).unwrap();
            assert_eq!(c.get_account_balance(bob()), 50);
        }
        #[ink::test] fn unlock_reverses() {
            let mut c = TrainBooking::new(alice(), 10, 100, 1, ir_hash());
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(alice());
            c.lock_state(1, 5, 10).unwrap();
            c.unlock_state(1).unwrap();
            assert_eq!(c.get_available_remain(), 100);
        }
        #[ink::test] fn exposes_ir_hash() {
            let c = TrainBooking::new(alice(), 10, 100, 1, ir_hash());
            assert_eq!(c.ir_hash(), ir_hash());
        }
    }
}
