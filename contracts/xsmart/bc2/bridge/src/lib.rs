#![cfg_attr(not(feature = "std"), no_std, no_main)]

#[ink::contract]
mod xbridge_bc2 {
    use ink::env::call::{build_call, ExecutionInput, Selector};
    use ink::env::DefaultEnvironment;
    use ink::prelude::string::String;
    use ink::prelude::vec::Vec;
    use ink::storage::Mapping;

    #[derive(scale::Encode, scale::Decode, Debug, PartialEq, Eq)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum Error {
        NotRelayer,
        CallFailed,
        StateError,
    }

    #[derive(scale::Encode, scale::Decode, Debug, PartialEq, Eq)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum TrainBookingError {
        NotBridge,
        ZeroAmount,
        InsufficientRemain,
        AlreadyLocked,
        NotLocked,
        NotTimedOut,
    }

    pub type Result<T> = core::result::Result<T, Error>;
    pub type TrainResult<T> = core::result::Result<T, TrainBookingError>;

    #[derive(scale::Encode, scale::Decode, Default, Clone)]
    #[cfg_attr(
        feature = "std",
        derive(scale_info::TypeInfo, ::ink::storage::traits::StorageLayout)
    )]
    pub struct PendingOp {
        amount_a: u64,
        amount_b: u64,
        active: bool,
    }

    #[ink(storage)]
    pub struct XBridgeBc2 {
        relayer: AccountId,
        state_contract: AccountId,
        pending_ops: Mapping<u64, PendingOp>,
    }

    #[ink(event)]
    pub struct CrossChainLockResponse {
        #[ink(topic)]
        cross_chain_tx_id: u64,
        #[ink(topic)]
        state_contract: AccountId,
        locked_state: Vec<u8>,
        ir_hash: Hash,
        proof: Vec<u8>,
    }

    #[ink(event)]
    pub struct CrossChainUpdateAck {
        #[ink(topic)]
        cross_chain_tx_id: u64,
        #[ink(topic)]
        state_contract: AccountId,
        success: bool,
    }

    #[ink(event)]
    pub struct CrossChainRollback {
        #[ink(topic)]
        cross_chain_tx_id: u64,
        #[ink(topic)]
        state_contract: AccountId,
    }

    #[ink(event)]
    pub struct GPACTSegmentEvent {
        tx_id: String,
        call_tree_hash: String,
        chain_id: u64,
        segment_id: u64,
    }

    #[ink(event)]
    pub struct GPACTSignallingEvent {
        tx_id: String,
        call_tree_hash: String,
        chain_id: u64,
        segment_id: u64,
        commit: bool,
        abort_tx: bool,
    }

    #[ink(event)]
    pub struct ATOMLockEvent {
        invoke_id: String,
        lock_hash: String,
        kind: String,
        user: String,
        amount_a: u64,
        amount_b: u64,
    }

    #[ink(event)]
    pub struct ATOMUnlockEvent {
        invoke_id: String,
        hash_key_hex: String,
        kind: String,
        undo: bool,
    }

    impl XBridgeBc2 {
        #[ink(constructor)]
        pub fn new(relayer: AccountId, state_contract: AccountId) -> Self {
            Self {
                relayer,
                state_contract,
                pending_ops: Mapping::default(),
            }
        }

        #[ink(message)]
        pub fn relayer(&self) -> AccountId {
            self.relayer
        }

        #[ink(message)]
        pub fn state_contract(&self) -> AccountId {
            self.state_contract
        }

        #[ink(message)]
        pub fn set_relayer(&mut self, relayer: AccountId) -> Result<()> {
            self.ensure_relayer()?;
            self.relayer = relayer;
            Ok(())
        }

        #[ink(message)]
        pub fn set_state_contract(&mut self, state_contract: AccountId) -> Result<()> {
            self.ensure_relayer()?;
            self.state_contract = state_contract;
            Ok(())
        }

        #[ink(message)]
        pub fn receive_lock_request(
            &mut self,
            cross_chain_tx_id: u64,
            num: u64,
            timeout_blocks: BlockNumber,
        ) -> Result<(Vec<u8>, Hash, Vec<u8>)> {
            self.ensure_relayer()?;

            let result: core::result::Result<
                core::result::Result<TrainResult<(Vec<u8>, Hash, Vec<u8>)>, ink::LangError>,
                ink::env::Error,
            > =
                build_call::<DefaultEnvironment>()
                    .call(self.state_contract)
                    .exec_input(
                        ExecutionInput::new(Selector::new(ink::selector_bytes!("lock_state")))
                            .push_arg(cross_chain_tx_id)
                            .push_arg(num)
                            .push_arg(timeout_blocks),
                    )
                    .returns::<TrainResult<(Vec<u8>, Hash, Vec<u8>)>>()
                    .try_invoke();

            let (encoded_state, ir_hash, proof) = result
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::StateError)?;
            self.env().emit_event(CrossChainLockResponse {
                cross_chain_tx_id,
                state_contract: self.state_contract,
                locked_state: encoded_state.clone(),
                ir_hash,
                proof: proof.clone(),
            });
            Ok((encoded_state, ir_hash, proof))
        }

        #[ink(message)]
        pub fn receive_update_request(
            &mut self,
            cross_chain_tx_id: u64,
            new_remain: u64,
            user: AccountId,
            num: u64,
            total_cost: Balance,
        ) -> Result<()> {
            self.ensure_relayer()?;

            let result: core::result::Result<
                core::result::Result<TrainResult<()>, ink::LangError>,
                ink::env::Error,
            > = build_call::<DefaultEnvironment>()
                .call(self.state_contract)
                .exec_input(
                    ExecutionInput::new(Selector::new(ink::selector_bytes!("update_state")))
                        .push_arg(cross_chain_tx_id)
                        .push_arg(new_remain)
                        .push_arg(user)
                        .push_arg(num)
                        .push_arg(total_cost),
                )
                .returns::<TrainResult<()>>()
                .try_invoke();

            result
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::StateError)?;
            self.env().emit_event(CrossChainUpdateAck {
                cross_chain_tx_id,
                state_contract: self.state_contract,
                success: true,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn receive_rollback_request(&mut self, cross_chain_tx_id: u64) -> Result<()> {
            self.ensure_relayer()?;

            let result: core::result::Result<
                core::result::Result<TrainResult<()>, ink::LangError>,
                ink::env::Error,
            > = build_call::<DefaultEnvironment>()
                .call(self.state_contract)
                .exec_input(
                    ExecutionInput::new(Selector::new(ink::selector_bytes!("unlock_state")))
                        .push_arg(cross_chain_tx_id),
                )
                .returns::<TrainResult<()>>()
                .try_invoke();

            result
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::StateError)?;
            self.env().emit_event(CrossChainRollback {
                cross_chain_tx_id,
                state_contract: self.state_contract,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn receive_timeout_rollback(&mut self, cross_chain_tx_id: u64) -> Result<()> {
            self.ensure_relayer()?;

            let result: core::result::Result<
                core::result::Result<TrainResult<()>, ink::LangError>,
                ink::env::Error,
            > = build_call::<DefaultEnvironment>()
                .call(self.state_contract)
                .exec_input(
                    ExecutionInput::new(Selector::new(ink::selector_bytes!("unlock_on_timeout")))
                        .push_arg(cross_chain_tx_id),
                )
                .returns::<TrainResult<()>>()
                .try_invoke();

            result
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::StateError)?;
            self.env().emit_event(CrossChainRollback {
                cross_chain_tx_id,
                state_contract: self.state_contract,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn gpact_segment(
            &mut self,
            tx_id: String,
            call_tree_hash: String,
            chain_id: u64,
            segment_id: u64,
        ) -> Result<()> {
            self.ensure_relayer()?;
            let op_id = Self::id_from_string(&tx_id);
            self.lock_remote(op_id, 1, 30)?;
            self.pending_ops.insert(op_id, &PendingOp {
                amount_a: 1,
                amount_b: 1,
                active: true,
            });
            self.env().emit_event(GPACTSegmentEvent {
                tx_id,
                call_tree_hash,
                chain_id,
                segment_id,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn gpact_signalling(
            &mut self,
            tx_id: String,
            call_tree_hash: String,
            chain_id: u64,
            segment_id: u64,
            commit: bool,
            abort_tx: bool,
        ) -> Result<()> {
            self.ensure_relayer()?;
            let op_id = Self::id_from_string(&tx_id);
            if commit && !abort_tx {
                self.commit_remote(op_id)?;
            } else {
                self.unlock_remote(op_id)?;
                self.pending_ops.remove(op_id);
            }
            self.env().emit_event(GPACTSignallingEvent {
                tx_id,
                call_tree_hash,
                chain_id,
                segment_id,
                commit,
                abort_tx,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn gpact_timeout_unlock(
            &mut self,
            tx_id: String,
            chain_id: u64,
            segment_id: u64,
        ) -> Result<()> {
            self.ensure_relayer()?;
            let op_id = Self::id_from_string(&tx_id);
            self.unlock_remote(op_id)?;
            self.pending_ops.remove(op_id);
            self.env().emit_event(GPACTSignallingEvent {
                tx_id,
                call_tree_hash: String::new(),
                chain_id,
                segment_id,
                commit: false,
                abort_tx: true,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn atom_lock_do(
            &mut self,
            invoke_id: String,
            lock_hash: String,
            kind: String,
            user: String,
            amount_a: u64,
            amount_b: u64,
        ) -> Result<()> {
            self.ensure_relayer()?;
            let op_id = Self::id_from_string(&invoke_id);
            let total = amount_a.saturating_add(amount_b);
            self.lock_remote(op_id, total.max(1), 30)?;
            self.pending_ops.insert(op_id, &PendingOp {
                amount_a,
                amount_b,
                active: true,
            });
            self.env().emit_event(ATOMLockEvent {
                invoke_id,
                lock_hash,
                kind,
                user,
                amount_a,
                amount_b,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn atom_unlock(
            &mut self,
            invoke_id: String,
            hash_key_hex: String,
            kind: String,
        ) -> Result<()> {
            self.ensure_relayer()?;
            let op_id = Self::id_from_string(&invoke_id);
            self.commit_remote(op_id)?;
            self.env().emit_event(ATOMUnlockEvent {
                invoke_id,
                hash_key_hex,
                kind,
                undo: false,
            });
            Ok(())
        }

        #[ink(message)]
        pub fn atom_undo_unlock(
            &mut self,
            invoke_id: String,
            hash_key_hex: String,
            kind: String,
        ) -> Result<()> {
            self.ensure_relayer()?;
            let op_id = Self::id_from_string(&invoke_id);
            self.unlock_remote(op_id)?;
            self.pending_ops.remove(op_id);
            self.env().emit_event(ATOMUnlockEvent {
                invoke_id,
                hash_key_hex,
                kind,
                undo: true,
            });
            Ok(())
        }

        fn ensure_relayer(&self) -> Result<()> {
            if self.env().caller() == self.relayer {
                Ok(())
            } else {
                Err(Error::NotRelayer)
            }
        }

        fn lock_remote(&mut self, id: u64, amount: u64, timeout_blocks: BlockNumber) -> Result<()> {
            let result: core::result::Result<
                core::result::Result<TrainResult<(Vec<u8>, Hash, Vec<u8>)>, ink::LangError>,
                ink::env::Error,
            > = build_call::<DefaultEnvironment>()
                .call(self.state_contract)
                .exec_input(
                    ExecutionInput::new(Selector::new(ink::selector_bytes!("lock_state")))
                        .push_arg(id)
                        .push_arg(amount)
                        .push_arg(timeout_blocks),
                )
                .returns::<TrainResult<(Vec<u8>, Hash, Vec<u8>)>>()
                .try_invoke();

            let _ = result
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::StateError)?;
            Ok(())
        }

        fn unlock_remote(&mut self, id: u64) -> Result<()> {
            let result: core::result::Result<
                core::result::Result<TrainResult<()>, ink::LangError>,
                ink::env::Error,
            > = build_call::<DefaultEnvironment>()
                .call(self.state_contract)
                .exec_input(
                    ExecutionInput::new(Selector::new(ink::selector_bytes!("unlock_state")))
                        .push_arg(id),
                )
                .returns::<TrainResult<()>>()
                .try_invoke();

            result
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::StateError)?;
            Ok(())
        }

        fn commit_remote(&mut self, id: u64) -> Result<()> {
            let pending = self.pending_ops.get(id).ok_or(Error::StateError)?;
            if !pending.active {
                return Err(Error::StateError);
            }
            self.unlock_remote(id)?;
            let amount = pending.amount_a.saturating_add(pending.amount_b).max(1);
            let result: core::result::Result<
                core::result::Result<TrainResult<Balance>, ink::LangError>,
                ink::env::Error,
            > = build_call::<DefaultEnvironment>()
                .call(self.state_contract)
                .exec_input(
                    ExecutionInput::new(Selector::new(ink::selector_bytes!("book_local")))
                        .push_arg(self.relayer)
                        .push_arg(amount),
                )
                .returns::<TrainResult<Balance>>()
                .try_invoke();

            let _ = result
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::CallFailed)?
                .map_err(|_| Error::StateError)?;
            self.pending_ops.remove(id);
            Ok(())
        }

        fn id_from_string(value: &String) -> u64 {
            let mut out = 1469598103934665603u64;
            for byte in value.as_bytes() {
                out ^= *byte as u64;
                out = out.wrapping_mul(1099511628211u64);
            }
            if out == 0 { 1 } else { out }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn alice() -> AccountId {
            AccountId::from([1u8; 32])
        }

        fn bob() -> AccountId {
            AccountId::from([2u8; 32])
        }

        #[ink::test]
        fn stores_constructor_values() {
            let bridge = XBridgeBc2::new(alice(), bob());
            assert_eq!(bridge.relayer(), alice());
            assert_eq!(bridge.state_contract(), bob());
        }

        #[ink::test]
        fn rejects_non_relayer_management_calls() {
            let mut bridge = XBridgeBc2::new(alice(), bob());
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(bob());
            assert_eq!(bridge.set_state_contract(alice()), Err(Error::NotRelayer));
            assert_eq!(bridge.set_relayer(bob()), Err(Error::NotRelayer));
        }
    }
}
