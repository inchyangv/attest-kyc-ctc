// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IProofmarkRegistry {
    function isVerified(address subject, uint256 policyId) external view returns (bool);
}

/// @title GatedRwaNote
/// @notice 정책을 통과한 지갑끼리만 이전되는 RWA 데모 토큰 (신용채권 노트).
/// @dev docs/03-product-plan.md §5.1 L3 — "Attestcoin 을 빼면 무너진다"를 눈으로 보여주는 컨트랙트.
///
/// 토큰화 자산은 **보유자 자격 심사가 법적 요건**이다. 이 컨트랙트는 그 요건을
/// 이전(transfer) 시점에 강제한다. 판정 근거는 이더리움에서 발급되고 Attestcoin 으로
/// 검증되어 Creditcoin 에 물질화된 마크다 — 중앙 서명 서버가 아니다.
///
/// 정책은 **생성자에서 고정**한다. 어느 정책으로 게이팅하는지가 이 토큰의 성질이기 때문이다.
/// KR 정책과 EU 정책으로 각각 배포하면 같은 마크가 서로 다르게 판정되는 것을 보여줄 수 있다.
contract GatedRwaNote is ERC20, Ownable2Step {
    IProofmarkRegistry public immutable REGISTRY;

    /// @notice 이 토큰이 요구하는 컴플라이언스 정책. 불변이다.
    uint256 public immutable POLICY_ID;

    error SenderNotVerified(address from, uint256 policyId);
    error RecipientNotVerified(address to, uint256 policyId);

    constructor(string memory name_, string memory symbol_, address registry, uint256 policyId, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    {
        require(registry != address(0), "zero registry");
        REGISTRY  = IProofmarkRegistry(registry);
        POLICY_ID = policyId;
    }

    /// @notice 발행. 수취인은 정책을 통과해야 한다 (아래 _update 가 강제).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice 상환/소각.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @dev OZ 5.x 의 단일 이전 훅. mint(from=0)·burn(to=0)·transfer 가 모두 여기를 지난다.
    ///
    ///      ★ 양방향 검사 — 송신자와 수신자 **둘 다** 통과해야 한다.
    ///        한쪽만 걸면 제재 지갑이 토큰을 *받는* 것을 막지 못한다.
    ///
    ///      ★ 0주소 예외 — mint 는 from == 0, burn 은 to == 0 이다.
    ///        여기서 isVerified(address(0)) 를 부르면 발행·소각이 전부 막힌다.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && !REGISTRY.isVerified(from, POLICY_ID)) {
            revert SenderNotVerified(from, POLICY_ID);
        }
        if (to != address(0) && !REGISTRY.isVerified(to, POLICY_ID)) {
            revert RecipientNotVerified(to, POLICY_ID);
        }
        super._update(from, to, value);
    }

    /// @notice 이전 가능 여부를 미리 조회한다 (프론트엔드가 버튼을 비활성화할 때 쓴다).
    function canTransfer(address from, address to) external view returns (bool) {
        return REGISTRY.isVerified(from, POLICY_ID) && REGISTRY.isVerified(to, POLICY_ID);
    }
}
