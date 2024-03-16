import { Storage, Arrays, Protobuf, System, SafeMath, authority, error, Base58, StringBytes } from "@koinos/sdk-as";
import { token } from "./proto/token";
import { SupplyStorage } from "./state/SupplyStorage";
import { BalancesStorage } from "./state/BalancesStorage";
import { IToken, nft } from "@koinosbox/contracts";
import { Nft } from "./Nft";
import { collections } from "./proto/collections";
import { System2 } from "@koinosbox/contracts";
import { Token as newToken } from "@koinosbox/contracts";

const SUPPLY_SPACE_ID = 0;
const BALANCES_SPACE_ID = 1;
const ALLOWANCES_SPACE_ID = 2;

export class Token {
  callArgs: System.getArgumentsReturn | null;
  // SETTINGS BEGIN
  _name: string = "Koinos World";
  _symbol: string = "WORLD";
  _decimals: u32 = 8;

  // set _maxSupply to zero if there is no max supply
  // if set to zero, the supply would still be limited by how many tokens can fit in a u64 (u64.MAX_VALUE)
  _maxSupply: u64 = 3000000000000000;

  // SETTINGS END

  _contractId: Uint8Array = System.getContractId();
  _supplyStorage: SupplyStorage = new SupplyStorage(this._contractId);
  _balancesStorage: BalancesStorage = new BalancesStorage(this._contractId);

  allowances: Storage.Map<Uint8Array, token.uint64> = new Storage.Map(
    this._contractId,
    ALLOWANCES_SPACE_ID,
    token.uint64.decode,
    token.uint64.encode,
    () => new token.uint64(0)
  );


  name(args: token.name_arguments): token.name_result {
    return new token.name_result(this._name);
  }

  symbol(args: token.symbol_arguments): token.symbol_result {
    return new token.symbol_result(this._symbol);
  }

  decimals(args: token.decimals_arguments): token.decimals_result {
    return new token.decimals_result(this._decimals);
  }

  total_supply(args: token.total_supply_arguments): token.total_supply_result {
    const supply = this._supplyStorage.get()!;

    const res = new token.total_supply_result();
    res.value = supply.value;

    return res;
  }

  max_supply(args: token.max_supply_arguments): token.max_supply_result {
    return new token.max_supply_result(this._maxSupply);
  }

  balance_of(args: token.balance_of_arguments): token.balance_of_result {
    const owner = args.owner;

    const balanceObj = this._balancesStorage.get(owner)!;

    const res = new token.balance_of_result();
    res.value = balanceObj.value;

    return res;
  }

  /**
   * Internal function to check if the account triggered
   * the operation, or if another account is authorized
   */
  check_authority(account: Uint8Array, amount: u64): boolean {
    // check if the operation is authorized directly by the user
    if (System2.check_authority(account)) return true;

    // check if the user authorized the caller
    const caller = System.getCaller();
    if (!caller.caller || caller.caller.length == 0) return false;
    const key = new Uint8Array(50);
    key.set(account, 0);
    key.set(caller.caller, 25);
    const allowance = this.allowances.get(key)!;
    if (allowance.value >= amount) {
      // spend allowance
      allowance.value -= amount;
      this.allowances.put(key, allowance);
      return true;
    }

    return false;
  }

  _approve(args: token.approve_arguments): void {
    const key = new Uint8Array(50);
    key.set(args.owner, 0);
    key.set(args.spender, 25);
    this.allowances.put(key, new token.uint64(args.value));

    const impacted = [args.spender, args.owner];
    System.event(
      "token.approve_event",
      Protobuf.encode<token.approve_arguments>(args, token.approve_arguments.encode),
      impacted
    );
  }

  _transfer(args: token.transfer_arguments): void {
    const from = args.from;
    const to = args.to;
    const value = args.value;

    const fromBalance = this._balancesStorage.get(from)!;
    System.require(
      fromBalance.value >= args.value,
      "account 'from' has insufficient balance"
    );

    fromBalance.value -= args.value;
    this._balancesStorage.put(from, fromBalance);

    const toBalance = this._balancesStorage.get(to)!;
    toBalance.value += args.value;

    this._balancesStorage.put(to, toBalance);

    const impacted = [args.to, args.from];
    const transferEvent = new token.transfer_event(from, to, value);

    System.event('koinos.contracts.token.transfer_event', Protobuf.encode(transferEvent, token.transfer_event.encode), impacted);

  }
  

  // transfer(args: token.transfer_arguments): token.empty_message {
  //   const from = args.from;
  //   const to = args.to;
  //   const value = args.value;

  //   System.require(!Arrays.equal(from, to), 'Cannot transfer to self');

  //   System.require(
  //     Arrays.equal(System.getCaller().caller, args.from) ||
  //     System.checkAuthority(authority.authorization_type.contract_call, args.from, System.getArguments().args),
  //     "'from' has not authorized transfer",
  //     error.error_code.authorization_failure
  //   );

  //   const fromBalance = this._balancesStorage.get(from)!;

  //   System.require(fromBalance.value >= value, "'from' has insufficient balance");

  //   const toBalance = this._balancesStorage.get(to)!;

  //   // the balances cannot hold more than the supply, so we don't check for overflow/underflow
  //   fromBalance.value -= value;
  //   toBalance.value += value;

  //   this._balancesStorage.put(from, fromBalance);
  //   this._balancesStorage.put(to, toBalance);

  //   const transferEvent = new token.transfer_event(from, to, value);
  //   const impacted = [to, from];

  //   System.event('koinos.contracts.token.transfer_event', Protobuf.encode(transferEvent, token.transfer_event.encode), impacted);

  //   return new token.empty_message();
  // }

  transfer(args: token.transfer_arguments): token.empty_message {
    const isAuthorized = this.check_authority(args.from, args.value);
    System.require(isAuthorized, "from has not authorized transfer");
    this._transfer(args);
    return new token.empty_message();
  }

  mint(args: token.mint_arguments): token.empty_message {
    const to = args.to;
    const value = args.value;

    System.requireAuthority(authority.authorization_type.contract_call, Base58.decode("1NPvJuEDhjLuW3VbGqAQe4MdSWSB3YWxK1"));

    const supply = this._supplyStorage.get()!;

    const newSupply = SafeMath.tryAdd(supply.value, value);

    System.require(!newSupply.error, 'Mint would overflow supply');

    System.require(this._maxSupply == 0 || newSupply.value <= this._maxSupply, 'Mint would overflow max supply');

    const toBalance = this._balancesStorage.get(to)!;
    toBalance.value += value;

    supply.value = newSupply.value;

    this._supplyStorage.put(supply);
    this._balancesStorage.put(to, toBalance);

    const mintEvent = new token.mint_event(to, value);
    const impacted = [to];

    System.event('koinos.contracts.token.mint_event', Protobuf.encode(mintEvent, token.mint_event.encode), impacted);

    return new token.empty_message();
  }

  drop_rewards(args: token.drop_rewards_arguments): token.empty_message {

    const initialRewards: Map<u64, u64> = new Map<u64, u64>();
    initialRewards.set(0, 2000000000000);
    initialRewards.set(1, 1000000000000);
    initialRewards.set(2, 750000000000);
    initialRewards.set(3, 500000000000);

    const nft_contract = new Nft(Base58.decode("1NxweGyS8pzR84xUY4AZrChhUC4pdGEpQk"))
    // const nft_supply = nft_contract.total_supply().value;

    // const res = new token.uint64_object();
    System.requireAuthority(authority.authorization_type.contract_call, Base58.decode("1NPvJuEDhjLuW3VbGqAQe4MdSWSB3YWxK1"));

    for (let i = 1; i <= 210; i++) {
      const token_id = new Uint8Array(i)
      const owner = nft_contract.owner_of(new collections.owner_of_arguments(StringBytes.stringToBytes(`${i}`))).value;

      let tier: u64;

      if (i == 1) {
        tier = 0;
      } else if (i < 37) {
        tier = 1;
      } else if (i < 101) {
        tier = 2;
      } else {
        tier = 3;
      }

      // Constants for reward rates
      let rewardRate: u64 = 0;

      // Applying different percentage increases based on tier using if-else statements
      if (tier === 0) {
        rewardRate = 5; // 5% per month for Tier 0
      } else if (tier === 1) {
        rewardRate = 2; // 2% per month for Tier 1
      } else if (tier === 2) {
        rewardRate = 15; // 1.5% per month for Tier 2
      } else if (tier === 3) {
        rewardRate = 1; // 1% per month for Tier 3
      }


      const monthsDifference: u64 = this.get_timestamp(new token.get_timestamp_arguments(token_id)).value;

      const initialReward: u64 = initialRewards.get(tier);

      // Calculate the total reward based on the formula
      let totalAmount: u64;
      if (monthsDifference >= 1) {
        // Calculate the total reward based on the formula: initial reward + (initial reward * reward rate * months difference)
        totalAmount = initialReward + ((initialReward * rewardRate * monthsDifference) / 100);
      } else {
        // If less than 1 month, use the base reward
        totalAmount = initialReward;
      }

      const supply = this._supplyStorage.get()!;
      const newSupply = SafeMath.tryAdd(supply.value, totalAmount);
      System.require(newSupply.value <= 600000000000000, 'Mint would overflow max reward limit');
      this.mint(new token.mint_arguments(owner, totalAmount));
    }


    return new token.empty_message();
  }

  drop_rewards_temp(args: token.drop_rewards_temp_arguments): token.empty_message {

    const initialRewards: Map<u64, u64> = new Map<u64, u64>();
    initialRewards.set(0, 2000000000000);
    initialRewards.set(1, 1000000000000);
    initialRewards.set(2, 750000000000);
    initialRewards.set(3, 500000000000);

    const nft_contract = new Nft(Base58.decode("1NxweGyS8pzR84xUY4AZrChhUC4pdGEpQk"))
    // const nft_supply = nft_contract.total_supply().value;

    // const res = new token.uint64_object();
    System.requireAuthority(authority.authorization_type.contract_call, Base58.decode("1NPvJuEDhjLuW3VbGqAQe4MdSWSB3YWxK1")); //

    for (let i = 1; i <= 210; i++) {
      const token_id = new Uint8Array(i)
      const owner = nft_contract.owner_of(new collections.owner_of_arguments(StringBytes.stringToBytes(`${i}`))).value;

      if (Arrays.equal(owner, Base58.decode("1D62Bo53T3V6KN4nFwsF1hicDMYs6f13JB"))) {       // 1D62Bo53T3V6KN4nFwsF1hicDMYs6f13JB
        continue
      } else {
        let tier: u64;

        if (i == 1) {
          tier = 0;
        } else if (i < 37) {
          tier = 1;
        } else if (i < 101) {
          tier = 2;
        } else {
          tier = 3;
        }

        // Constants for reward rates
        let rewardRate: u64 = 0;

        // Applying different percentage increases based on tier using if-else statements
        if (tier === 0) {
          rewardRate = 5; // 5% per month for Tier 0
        } else if (tier === 1) {
          rewardRate = 2; // 2% per month for Tier 1
        } else if (tier === 2) {
          rewardRate = 15; // 1.5% per month for Tier 2
        } else if (tier === 3) {
          rewardRate = 1; // 1% per month for Tier 3
        }


        const monthsDifference: u64 = this.get_timestamp(new token.get_timestamp_arguments(token_id)).value;

        const initialReward: u64 = initialRewards.get(tier);

        // Calculate the total reward based on the formula
        let totalAmount: u64;
        if (monthsDifference >= 1) {
          // Calculate the total reward based on the formula: initial reward + (initial reward * reward rate * months difference)
          totalAmount = initialReward + ((initialReward * rewardRate * monthsDifference) / 100);
        } else {
          // If less than 1 month, use the base reward
          totalAmount = initialReward * 5;
        }

        const supply = this._supplyStorage.get()!;
        const newSupply = SafeMath.tryAdd(supply.value, totalAmount);
        System.require(newSupply.value <= 600000000000000, 'Mint would overflow max reward limit');
        this.mint(new token.mint_arguments(owner, totalAmount));
      }
    }


    return new token.empty_message();
  }


  get_timestamp(args: token.get_timestamp_arguments): token.uint64_object {
    const token_id = args.token_id;

    const nft_contract = new Nft(Base58.decode("1NxweGyS8pzR84xUY4AZrChhUC4pdGEpQk"))
    // YOUR CODE HERE

    const res = new token.uint64_object();
    const timestamp = nft_contract.get_timestamp(new collections.get_timestamp_arguments(StringBytes.stringToBytes(`${token_id}`))).value;

    const millisecondsInMonth = 1000 * 60 * 60 * 24 * 30; // Assuming each month has 30 days
    const timeDifference = System.getHeadInfo().head_block_time - timestamp;
    const monthsDifference = timeDifference / millisecondsInMonth;

    res.value = monthsDifference;
    // res.value = nft_contract.total_supply().value;
    return res;
  }

  burn(args: token.burn_arguments): token.empty_message {
    const from = args.from;
    const value = args.value;

    System.require(
      Arrays.equal(System.getCaller().caller, args.from) ||
      System.checkAuthority(authority.authorization_type.contract_call, args.from, System.getArguments().args),
      "'from' has not authorized transfer",
      error.error_code.authorization_failure
    );

    const fromBalance = this._balancesStorage.get(from)!;

    System.require(fromBalance.value >= value, "'from' has insufficient balance");

    const supply = this._supplyStorage.get()!;

    const newSupply = SafeMath.sub(supply.value, value);

    supply.value = newSupply;
    fromBalance.value -= value;

    this._supplyStorage.put(supply);
    this._balancesStorage.put(from, fromBalance);

    const burnEvent = new token.burn_event(from, value);
    const impacted = [from];

    System.event('koinos.contracts.token.burn_event', Protobuf.encode(burnEvent, token.burn_event.encode), impacted);

    return new token.empty_message();
  }


  approve(args: token.approve_arguments): token.empty_message {
    const owner = args.owner;
    const spender = args.spender;
    const value = args.value;

    const isAuthorized = System2.check_authority(owner);
    System.require(isAuthorized, "approve operation not authorized");
    this._approve(args);

    const res = new token.empty_message();

    return res;
  }

  allowance(args: token.allowance_arguments): token.allowance_result {
    const owner = args.owner;
    const spender = args.spender;

    const res = new token.allowance_result();

    const key = new Uint8Array(50);
    key.set(owner, 0);
    key.set(spender, 25);

    res.value =  this.allowances.get(key)!.value;
    return res;
  }

  get_allowances(
    args: token.get_allowances_arguments
  ): token.get_allowances_result {
    // const owner = args.owner;
    // const start = args.start;
    // const limit = args.limit;
    // const direction = args.direction;


    let key = new Uint8Array(50);
    key.set(args.owner, 0);
    key.set(args.start ? args.start : new Uint8Array(0), 25);
    const result = new token.get_allowances_result(args.owner, []);
    for (let i = 0; i < args.limit; i += 1) {
      const nextAllowance =
        args.direction == token.direction.ascending
          ? this.allowances.getNext(key)
          : this.allowances.getPrev(key);
      if (
        !nextAllowance ||
        !Arrays.equal(args.owner, nextAllowance.key!.slice(0, 25))
      )
        break;
      const spender = nextAllowance.key!.slice(25);
      result.allowances.push(
        new token.spender_value(spender, nextAllowance.value.value)
      );
      key = nextAllowance.key!;
    }
    return result;
  }


}
